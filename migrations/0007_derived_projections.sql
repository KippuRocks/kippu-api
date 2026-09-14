-- The derived copy's projections (T-025-02, NFR-11, REQ-IX-1).
--
-- Ledger facts at interactive latency, with the filtering and ordering clients
-- need, without the ledger answering those queries. Every one is a copy: the
-- ledger is authoritative, and where the two disagree the ledger wins
-- (REQ-IX-1, REQ-IX-2). They are written only by the reader, from the log,
-- including writes Kippu never relayed.
--
-- Every row carries the log sequence of the last record that changed it, so a
-- response can say how fresh it is. Ledger timestamps are milliseconds since
-- the epoch, as the ledger states them. Nothing here is personal data (NFR-6):
-- identifiers, counts and flags only.

CREATE TABLE derived_events (
  id text PRIMARY KEY,
  owner text NOT NULL,
  status text NOT NULL CHECK (status IN ('Active', 'Sealed', 'Cancelled', 'Finished')),
  -- Null: issuance is unbounded (REQ-EV-3).
  max_capacity bigint CHECK (max_capacity >= 0),
  issued bigint NOT NULL CHECK (issued >= 0),
  -- The event's zones, in ledger order: [{ "id": ..., "kind": "Seated" | "Unseated" }].
  zones jsonb NOT NULL,
  sequence bigint NOT NULL REFERENCES derived_log (sequence)
);

CREATE INDEX derived_events_owner ON derived_events (owner, id);
CREATE INDEX derived_events_status ON derived_events (status, id);

CREATE TABLE derived_tickets (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES derived_events (id),
  holder text NOT NULL,
  class_id text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('Purchased', 'Granted')),
  zone_id text NOT NULL,
  placement_kind text NOT NULL CHECK (placement_kind IN ('Seated', 'Unseated')),
  position text,
  discriminator text,
  policy_kind text NOT NULL CHECK (policy_kind IN ('Single', 'Multiple', 'Unlimited')),
  policy_max bigint CHECK (policy_max >= 0),
  policy_until bigint,
  cannot_resale boolean NOT NULL,
  cannot_transfer boolean NOT NULL,
  -- Raised by exactly one per attendance the log records; never reset or lowered (INV-3).
  attendances bigint NOT NULL CHECK (attendances >= 0),
  sequence bigint NOT NULL REFERENCES derived_log (sequence),
  CHECK ((placement_kind = 'Seated') = (position IS NOT NULL)),
  CHECK ((placement_kind = 'Unseated') = (discriminator IS NOT NULL)),
  CHECK ((policy_kind = 'Multiple') = (policy_max IS NOT NULL)),
  CHECK (policy_kind <> 'Single' OR policy_until IS NULL)
);

CREATE INDEX derived_tickets_event ON derived_tickets (event_id, id);
-- Holdings (account -> tickets): every ticket an account holds, by event (US-D1, US-E1).
CREATE INDEX derived_tickets_holder ON derived_tickets (holder, event_id, id);

-- Recorded attendances per ticket, and when the last was recorded (REQ-OP-3).
CREATE TABLE derived_attendance (
  ticket_id text PRIMARY KEY REFERENCES derived_tickets (id),
  event_id text NOT NULL REFERENCES derived_events (id),
  count bigint NOT NULL CHECK (count > 0),
  -- When the ledger recorded the latest attendance, by its clock.
  last_recorded_at bigint NOT NULL,
  sequence bigint NOT NULL REFERENCES derived_log (sequence)
);

CREATE INDEX derived_attendance_event ON derived_attendance (event_id, ticket_id);
