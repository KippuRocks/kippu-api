-- Face value per purchased ticket (T-022-06; REQ-MP-2, OQ-20;
-- features/022-sales-and-holds/plan.md §5.6).
--
-- The price a ticket was originally sold at, for the ticket's life: what Epic C's
-- resale display shows beside an asking price (REQ-MP-2). It is a Kippu fact,
-- never a ledger one (AC-B4.2), recorded in the transaction that confirms the
-- sale's hold, from the asset and price the hold recorded — so every purchased
-- ticket Kippu sold has exactly one row, and a later price change touches none.

CREATE TABLE face_values (
  ticket text PRIMARY KEY CHECK (ticket ~ '^[0-9a-f]{64}$'),
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  class_id text NOT NULL REFERENCES ticket_classes (id),
  sale_id uuid NOT NULL UNIQUE REFERENCES primary_sales (id),
  -- In the event's sale asset's minor units.
  amount bigint NOT NULL CHECK (amount > 0),
  asset text NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX face_values_event ON face_values (event, class_id);
