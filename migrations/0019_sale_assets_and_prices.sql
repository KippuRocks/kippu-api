-- Sale assets and prices (T-021-14; US-B4, AC-B4.2, REQ-TC-1;
-- features/021-events-and-authority/plan.md "Prices").
--
-- Primary prices are Kippu's (SPEC.md §4.2) and never reach the ledger
-- (AC-B4.2). Each event has a sale asset the organiser picks — COPM/2 or DUSD/6,
-- as the payment provider's checkout supports — fixed once the event has a hold
-- or a sale. Every Purchased class has a price: a positive integer in the
-- asset's minor units. Granted classes have none.

CREATE TABLE event_sale_assets (
  event text PRIMARY KEY CHECK (event ~ '^[0-9a-f]{64}$'),
  asset text NOT NULL CHECK (asset IN ('COPM/2', 'DUSD/6')),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  set_request_id text NOT NULL,
  set_at timestamptz NOT NULL
);

ALTER TABLE ticket_classes ADD COLUMN price bigint CHECK (price > 0);
ALTER TABLE ticket_classes ADD COLUMN price_set_at timestamptz;

-- Not validated against rows written before prices existed: M1 classes are in no
-- production store, and a Purchased class defined from here on has a price.
ALTER TABLE ticket_classes ADD CONSTRAINT ticket_classes_price_by_provenance
  CHECK ((provenance = 'Purchased') = (price IS NOT NULL)) NOT VALID;

-- A hold records the sale terms in force when it was placed: a later price change
-- affects only holds placed afterwards. Holds placed before this migration have none.
ALTER TABLE holds ADD COLUMN asset text CHECK (asset IN ('COPM/2', 'DUSD/6'));
ALTER TABLE holds ADD COLUMN price bigint CHECK (price > 0);
ALTER TABLE holds ADD CONSTRAINT holds_sale_terms CHECK ((asset IS NULL) = (price IS NULL));
