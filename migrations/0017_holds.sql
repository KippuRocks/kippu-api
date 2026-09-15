-- Issuance holds (T-022-03; REQ-HD-1–REQ-HD-3, REQ-TC-5, INV-4, AC-B4.4).
--
-- A hold is a Kippu fact, not a ledger fact (REQ-HD-2): it reserves the issuance
-- of one ticket for one checkout before any payment is taken (REQ-HD-1). It has
-- no holder, produces no access pass, and cannot be transferred or resold.
--
-- An outstanding hold counts against the event's remaining capacity, against its
-- class's quota and, in a seated zone, against its position (REQ-HD-3). Holds are
-- placed one at a time per event, under a transaction-scoped advisory lock on
-- the event, so two buyers can never both hold the last ticket or the same seat;
-- the partial unique index below is the store's own guard for the seat.
--
-- A hold lives 10 minutes, extended once by 5 minutes when payment starts
-- (features/022-sales-and-holds/plan.md §5.2). It stops counting the moment it
-- expires, whether or not its lapse has been recorded yet.

CREATE TABLE holds (
  id uuid PRIMARY KEY,
  -- One hold per checkout: a checkout whose hold lapsed or was released is over.
  checkout_id uuid NOT NULL UNIQUE REFERENCES checkout_sessions (id),
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  zone text NOT NULL CHECK (zone ~ '^[0-9a-f]{64}$'),
  class_id text NOT NULL REFERENCES ticket_classes (id),
  -- The held seat's canonical designation in a seated zone; NULL for general admission.
  position text CHECK (length(position) BETWEEN 1 AND 100),
  -- outstanding: counts; lapsed: expired before it was confirmed; released: given up.
  status text NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding', 'lapsed', 'released')),
  expires_at timestamptz NOT NULL,
  -- Set once, when payment starts and the lifetime is extended.
  extended_at timestamptz,
  created_request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK ((status = 'outstanding') = (ended_at IS NULL))
);

CREATE UNIQUE INDEX holds_outstanding_position ON holds (event, zone, position)
  WHERE status = 'outstanding' AND position IS NOT NULL;
CREATE INDEX holds_outstanding_event ON holds (event, class_id) WHERE status = 'outstanding';
CREATE INDEX holds_outstanding_expiry ON holds (expires_at) WHERE status = 'outstanding';
CREATE INDEX granted_issuances_event ON granted_issuances (event) WHERE status <> 'rejected';
