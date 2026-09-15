-- Primary checkout audit records (T-022-09; REQ-MP-8, NFR-7).
--
-- Every primary sale is attributable end to end: each step of its checkout is
-- recorded with the request that caused it and who made it — the buyer's page,
-- Saifu's holder session, the payment provider's webhook, or the background
-- sweep — and the ticket's issuance, a relayed write, is joined to its audit_log
-- row by operation id.
--
-- Primary checkout is distinguishable from secondary purchases through the audit
-- log (REQ-MP-8): primary_checkout_audit is exactly the audit_log rows of
-- issuances a primary sale caused. Secondary purchases, which Saifu submits
-- directly, are never relayed and never appear here (NFR-11).
--
-- No payment or personal details are recorded: a step's detail names only
-- Kippu's and the provider's identifiers, amounts, and reasons.

CREATE TABLE checkout_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checkout_id uuid NOT NULL REFERENCES checkout_sessions (id),
  step text NOT NULL CHECK (step IN (
    'begun', 'linked', 'link-confirmed', 'link-discarded', 'held', 'hold-refused',
    'payment-started', 'checkout-cancelled', 'payment-verified', 'issued',
    'issuance-rejected', 'issuance-failed', 'refund-entitled'
  )),
  request_id text NOT NULL,
  actor text NOT NULL CHECK (actor IN (
    'anonymous', 'organiser', 'operator', 'holder', 'payment-provider', 'sweep'
  )),
  session_id uuid,
  holder_account text CHECK (holder_account ~ '^[0-9a-f]{64}$'),
  detail jsonb NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL
);

CREATE INDEX checkout_audit_checkout ON checkout_audit (checkout_id, id);

-- The issuance a sale relayed, by its audit_log row.
ALTER TABLE primary_sales ADD COLUMN operation_id text UNIQUE REFERENCES audit_log (operation_id);

CREATE VIEW primary_checkout_audit AS
  SELECT a.id, a.request_id, a.principal_kind, a.organiser_id, a.session_id, a.holder_account,
         a.operation_id, a.command_kind, a.recorded_at, a.outcome, a.receipt_cursor,
         a.error_code, a.completed_at, s.id AS sale_id, s.hold_id, h.checkout_id
  FROM audit_log a
  JOIN primary_sales s ON s.operation_id = a.operation_id
  JOIN holds h ON h.id = s.hold_id;
