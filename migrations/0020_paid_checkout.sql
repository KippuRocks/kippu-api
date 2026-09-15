-- Paid checkout (T-022-04; AC-B4.2, AC-B4.3, REQ-HD-1, REQ-TK-3;
-- features/022-sales-and-holds/plan.md §5.1 steps 4–7, §5.4).
--
-- Hold → hosted checkout → verified payment → issue → confirm. Charge, then
-- issue, then refund on failure: the provider has no authorise/capture split.
--
-- Nothing here reaches the ledger: a price, a payment and a refund are Kippu's
-- concern alone (AC-B4.2, NFR-6). Kippu stores no payment details: a hosted
-- checkout is the provider's identifier, its page, the amount and the asset.

-- A hold's statuses gain the paid path:
-- issuing: paid, and being issued — it counts, and no longer lapses;
-- confirmed: issued — the ticket counts as issued (REQ-TC-5, INV-4).
-- The price and asset a hold was placed at are 0019_sale_assets_and_prices's.
ALTER TABLE holds
  ADD COLUMN confirmed_at timestamptz,
  DROP CONSTRAINT holds_status_check,
  DROP CONSTRAINT holds_check;
ALTER TABLE holds
  ADD CONSTRAINT holds_status_check
    CHECK (status IN ('outstanding', 'issuing', 'confirmed', 'lapsed', 'released')),
  ADD CONSTRAINT holds_ended CHECK ((status IN ('lapsed', 'released')) = (ended_at IS NOT NULL)),
  ADD CONSTRAINT holds_confirmed CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL));

DROP INDEX holds_outstanding_position;
CREATE UNIQUE INDEX holds_allocated_position ON holds (event, zone, position)
  WHERE status IN ('outstanding', 'issuing', 'confirmed') AND position IS NOT NULL;
DROP INDEX holds_outstanding_event;
CREATE INDEX holds_allocated_event ON holds (event, class_id)
  WHERE status IN ('outstanding', 'issuing', 'confirmed');

-- A hosted checkout created for a hold, expiring with it. Single-use: once
-- cancelled or failed, a new one may replace it while the hold lives; at most one
-- is open at a time.
CREATE TABLE hosted_checkouts (
  id uuid PRIMARY KEY,
  hold_id uuid NOT NULL REFERENCES holds (id),
  provider_checkout_id text NOT NULL UNIQUE,
  url text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  asset text NOT NULL,
  -- As Kippu last read it from the provider.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  created_request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX hosted_checkouts_open ON hosted_checkouts (hold_id) WHERE status = 'open';

-- The issuance a verified payment started: at most one per paid hosted checkout.
CREATE TABLE primary_sales (
  id uuid PRIMARY KEY,
  hosted_checkout_id uuid NOT NULL UNIQUE REFERENCES hosted_checkouts (id),
  hold_id uuid NOT NULL REFERENCES holds (id),
  -- The holder account the ticket is issued to (AC-B4.1). Public; not personal data.
  holder_account text NOT NULL CHECK (holder_account ~ '^[0-9a-f]{64}$'),
  -- issuing: submitted or about to be; issued: the ledger recorded the ticket;
  -- rejected: the ledger refused it, or nothing was signed; failed: no verdict came
  -- back, so the ticket may exist, and the hold keeps counting.
  status text NOT NULL DEFAULT 'issuing'
    CHECK (status IN ('issuing', 'issued', 'rejected', 'failed')),
  ticket text CHECK (ticket ~ '^[0-9a-f]{64}$'),
  receipt_cursor text,
  error_code text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((status = 'issued') = (receipt_cursor IS NOT NULL)),
  CHECK ((status = 'issuing') = (completed_at IS NULL))
);

-- What Kippu owes a buyer who paid and got no ticket (plan §5.1 step 7, §5.5):
-- one per paid hosted checkout. Claims and disbursement are T-022-12 and T-022-08.
CREATE TABLE refund_entitlements (
  id uuid PRIMARY KEY,
  hosted_checkout_id uuid NOT NULL UNIQUE REFERENCES hosted_checkouts (id),
  checkout_id uuid NOT NULL REFERENCES checkout_sessions (id),
  amount bigint NOT NULL CHECK (amount > 0),
  asset text NOT NULL,
  -- issuance-rejected: the ledger refused the ticket, or nothing was signed;
  -- place-gone: the payment landed after the hold ended and the place was taken;
  -- amount-mismatch: the provider took another amount than the hold's price.
  reason text NOT NULL CHECK (reason IN ('issuance-rejected', 'place-gone', 'amount-mismatch')),
  created_at timestamptz NOT NULL
);
