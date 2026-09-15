-- Invitations (T-021-12; US-B2, REQ-TC-4, NFR-6; features/021-events-and-authority/plan.md §5.6).
--
-- An invitation is a granted ticket of a class, at a placement, waiting for a
-- guest: the link opens Saifu, which links the guest's holder account and
-- redeems the token, and Kippu issues the ticket to that account under the
-- organiser's authority, once. A Kippu fact; nothing here reaches the ledger
-- but the ticket the redemption issues.
--
-- The token is a bearer secret: only its SHA-256 is stored. The guest note is
-- the organiser's own text, possibly a name, and stays in Kippu (NFR-6).

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  class_id text NOT NULL REFERENCES ticket_classes (id),
  zone text NOT NULL CHECK (zone ~ '^[0-9a-f]{64}$'),
  placement_kind text NOT NULL CHECK (placement_kind IN ('Seated', 'Unseated')),
  -- The seat designation, for a seated placement.
  position text CHECK (length(position) BETWEEN 1 AND 100),
  guest text CHECK (length(guest) BETWEEN 1 AND 200),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  created_request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  -- open → redeeming → redeemed; back to open when the ledger or Kippu refuses the
  -- issuance; failed when issuance ended with no verdict, since the ticket may exist.
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'redeeming', 'redeemed', 'failed')),
  holder text CHECK (holder ~ '^[0-9a-f]{64}$'),
  ticket text CHECK (ticket ~ '^[0-9a-f]{64}$'),
  redeemed_at timestamptz,
  CHECK ((placement_kind = 'Seated') = (position IS NOT NULL)),
  CHECK ((status = 'open') = (holder IS NULL)),
  CHECK ((status = 'redeemed') = (ticket IS NOT NULL)),
  CHECK ((status = 'redeemed') = (redeemed_at IS NOT NULL))
);

CREATE INDEX invitations_event ON invitations (event, class_id, created_at);
