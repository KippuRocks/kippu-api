-- Capacity proofs and their review (T-021-08; US-A6, REQ-EV-5, REQ-EV-6, REQ-EV-7,
-- NFR-6; features/021-events-and-authority/plan.md §5.4).
--
-- An organiser asks for an increase — a higher capacity, or none at all — with an
-- artefact. The artefact is held in private object storage, under
-- artefact_key, never in the metadata bucket and never on the ledger: it will
-- contain venue and possibly personal data (NFR-6). A Kippu reviewer approves or
-- rejects; the row records the reviewer, the time and the decision. On approval a
-- random proof id is submitted with setEventCapacity, and the ledger's record of
-- it (the receipt's cursor) is kept here.
--
-- One pending request per event. An approval the ledger refuses leaves the
-- request pending.

CREATE TABLE capacity_proof_requests (
  id uuid PRIMARY KEY,
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  -- The capacity asked for; NULL removes the bound (REQ-EV-7).
  capacity bigint CHECK (capacity >= 0),
  artefact_key text NOT NULL UNIQUE,
  artefact_media_type text NOT NULL
    CHECK (artefact_media_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  artefact_size integer NOT NULL CHECK (artefact_size > 0),
  artefact_sha256 text NOT NULL CHECK (artefact_sha256 ~ '^[0-9a-f]{64}$'),
  request_id text NOT NULL,
  requested_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_id uuid REFERENCES reviewers (id),
  decision_request_id text,
  decided_at timestamptz,
  proof_id text UNIQUE CHECK (proof_id ~ '^[0-9a-f]{32}$'),
  receipt_cursor text,
  CHECK ((status = 'pending') = (reviewer_id IS NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decision_request_id IS NULL)),
  CHECK ((status = 'approved') = (proof_id IS NOT NULL)),
  CHECK ((status = 'approved') = (receipt_cursor IS NOT NULL))
);

CREATE UNIQUE INDEX capacity_proof_requests_one_pending
  ON capacity_proof_requests (event) WHERE status = 'pending';

CREATE INDEX capacity_proof_requests_queue
  ON capacity_proof_requests (requested_at) WHERE status = 'pending';

CREATE INDEX capacity_proof_requests_event ON capacity_proof_requests (event, requested_at);
