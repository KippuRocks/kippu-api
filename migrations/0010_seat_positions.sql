-- Canonical seat positions of seated zones (T-021-03; REQ-ID-3, REQ-ID-7).
--
-- The ledger makes a second ticket for the same position designation collide
-- (REQ-ID-2). That designations correspond one to one with physical seats — no
-- aliases, no invented seats — is Kippu's to attest (REQ-ID-2 note): the
-- organiser uploads each seated zone's canonical positions, and issuance
-- accepts only a position on that list, matched exactly
-- (features/021-events-and-authority/plan.md §5.3). "C-14" on the list does not
-- admit "c14".
--
-- A zone's identity and kind are ledger facts; this table only lists positions,
-- and rows for a zone are removed when the ledger removes the zone.

CREATE TABLE seat_positions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  zone text NOT NULL CHECK (zone ~ '^[0-9a-f]{64}$'),
  -- The designation as uploaded. The ledger's Position is its UTF-8 bytes.
  designation text NOT NULL CHECK (length(designation) BETWEEN 1 AND 100),
  created_request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (event, zone, designation)
);
