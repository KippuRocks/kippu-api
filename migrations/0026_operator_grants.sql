-- Operator grants by event, gates and window; revocation (T-024-02; US-E5, AC-E5.1).
--
-- Authorisation is granted, scoped and revoked entirely within Kippu: no ledger
-- state changes (AC-E5.1), and the ledger never learns who an operator is
-- (REQ-OP-1). A grant is active only inside its window, and until it is
-- revoked; revocation takes effect on the next check (F-024 plan §5.1).
--
-- Gates are the organiser's own labels, such as "North door", matched exactly.

CREATE TABLE operator_grants (
  id uuid PRIMARY KEY,
  -- The order grants were made in.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  operator_id uuid NOT NULL REFERENCES operators (id),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  -- The ledger's EventId, which the organiser owned when the grant was made.
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  gates text[] NOT NULL CHECK (cardinality(gates) BETWEEN 1 AND 100),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  created_request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_request_id text,
  CHECK (valid_until > valid_from),
  CHECK ((revoked_at IS NULL) = (revoked_request_id IS NULL))
);

-- The check: an operator's grants for one event.
CREATE INDEX operator_grants_operator_event ON operator_grants (operator_id, event);

-- The organiser's listing.
CREATE INDEX operator_grants_organiser ON operator_grants (organiser_id, event, seq);
