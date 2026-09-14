-- The audit log for relayed writes (T-020-07, NFR-7).
--
-- One row per ledger write Kippu relays, written before the write is signed,
-- attributing it to the request and principal that caused it. The outcome and
-- the receipt's cursor are recorded when the submission settles or is
-- rejected. A Kippu fact: the ledger's log stays authoritative for what was
-- written (REQ-IX-1). Writes Kippu never sees — direct from Saifu and
-- Iriguchi — are covered by the derived copy (NFR-11), not here.
--
-- Rows are appended and completed, never deleted.

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL,
  principal_kind text NOT NULL,
  organiser_id uuid,
  operator_id uuid,
  session_id uuid,
  operation_id text NOT NULL UNIQUE,
  command_kind text NOT NULL,
  recorded_at timestamptz NOT NULL,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'settled', 'rejected', 'failed')),
  receipt_cursor text,
  error_code text,
  completed_at timestamptz,
  CHECK ((outcome = 'settled') = (receipt_cursor IS NOT NULL)),
  CHECK ((outcome = 'rejected') = (error_code IS NOT NULL)),
  CHECK ((outcome = 'pending') = (completed_at IS NULL))
);

CREATE INDEX audit_log_request ON audit_log (request_id);
CREATE INDEX audit_log_organiser ON audit_log (organiser_id, recorded_at);
