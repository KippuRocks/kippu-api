-- Events created through Kippu, linked to their organiser (T-021-02; US-A1, REQ-EV-9).
--
-- The event itself is a ledger fact, and so are its owner, status, capacity and
-- zones (REQ-IX-1): the derived copy (derived_events) reflects them, and the
-- ledger wins wherever the two disagree. This table records only what Kippu
-- knows and the ledger does not: which organiser created the event, by which
-- request, and the log cursor of the creation, so a reader can wait for the
-- derived copy to reflect it (NFR-11). An event's owner account joins to its
-- organiser through organiser_ledger_accounts.

CREATE TABLE organiser_events (
  -- The ledger's EventId, derived from the owner account and a salt (REQ-EV-9).
  event text PRIMARY KEY CHECK (event ~ '^[0-9a-f]{64}$'),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  -- The operation that created it; its audit_log row attributes it (NFR-7).
  operation_id text NOT NULL UNIQUE,
  created_request_id text NOT NULL,
  receipt_cursor text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX organiser_events_organiser ON organiser_events (organiser_id, created_at);
