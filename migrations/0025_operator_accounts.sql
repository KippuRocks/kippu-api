-- Operator accounts under an organiser (T-024-01; US-E5, REQ-OP-1).
--
-- Kippu facts only: an operator is never known to the ledger. The organiser
-- names each operator, and issues one-time enrolment codes that Iriguchi redeems
-- for an operator session (auth.operator.redeemEnrolmentCode, T-020-05). The
-- name is the organiser's own label and stays in Kippu (NFR-6).

ALTER TABLE operators
  ADD COLUMN name text NOT NULL DEFAULT 'operator' CHECK (length(name) BETWEEN 1 AND 200),
  ADD COLUMN created_request_id text;

ALTER TABLE operators ALTER COLUMN name DROP DEFAULT;

-- The organiser's listing of their operators.
DROP INDEX operators_organiser;
CREATE INDEX operators_organiser ON operators (organiser_id, created_at);

-- A code issued by the organiser's request. Revoking an operator's sessions voids
-- every code of theirs not yet redeemed, so a revoked operator cannot enrol again
-- with a code issued before the revocation.
ALTER TABLE operator_enrolment_codes
  ADD COLUMN issued_request_id text,
  ADD COLUMN voided_at timestamptz;

CREATE INDEX operator_enrolment_codes_operator ON operator_enrolment_codes (operator_id)
  WHERE redeemed_at IS NULL AND voided_at IS NULL;
