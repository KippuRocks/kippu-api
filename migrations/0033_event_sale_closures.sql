-- Holds against organiser actions (T-022-05; REQ-HD-4;
-- features/022-sales-and-holds/plan.md §5.3).
--
-- Sealing or cancelling an event first releases every outstanding hold, cancels
-- its hosted checkout, and records a refund entitlement for any payment already
-- taken against a released hold; then the organiser's write is submitted
-- (features/021-events-and-authority/plan.md §5.5). Between the two, the event's
-- sales are closed in Kippu, so no checkout begins, no hold is placed, no
-- payment starts, and no late payment takes a place back. If the organiser's
-- write is refused, sales are reopened.

CREATE TABLE event_sale_closures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  closed_request_id text NOT NULL,
  closed_principal_kind text NOT NULL,
  closed_session_id uuid,
  closed_at timestamptz NOT NULL,
  reopened_request_id text,
  reopened_at timestamptz,
  CHECK ((reopened_at IS NULL) = (reopened_request_id IS NULL))
);

-- At most one closure in force per event.
CREATE UNIQUE INDEX event_sale_closures_in_force ON event_sale_closures (event)
  WHERE reopened_at IS NULL;

-- A payment taken against a hold released by an organiser action is refunded.
ALTER TABLE refund_entitlements DROP CONSTRAINT refund_entitlements_reason_check;
ALTER TABLE refund_entitlements ADD CONSTRAINT refund_entitlements_reason_check
  CHECK (reason IN ('issuance-rejected', 'place-gone', 'amount-mismatch', 'event-closed'));

ALTER TABLE checkout_audit DROP CONSTRAINT checkout_audit_step_check;
ALTER TABLE checkout_audit ADD CONSTRAINT checkout_audit_step_check CHECK (step IN (
  'begun', 'linked', 'link-confirmed', 'link-discarded', 'held', 'hold-refused',
  'payment-started', 'checkout-cancelled', 'payment-verified', 'issued',
  'issuance-rejected', 'issuance-failed', 'refund-entitled', 'hold-released'
));
