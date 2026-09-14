-- The derived copy's reader (T-025-01, NFR-11, AD-17).
--
-- One reader pulls the ledger's log through the SDK by cursor, in batches, and
-- applies each batch's projection updates and its new cursor in one
-- transaction: a crash never skips a record and never applies one twice.
-- Nothing here is authoritative (REQ-IX-1): the ledger's log is, and the copy
-- can be rebuilt from it at any time.

-- Where the reader has read to. One row, locked for the length of a batch, so
-- a second reader waits rather than applying the same records.
CREATE TABLE derived_reader (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- The SDK cursor to read from next. Opaque: compared for equality only.
  cursor text NOT NULL,
  -- The log sequence the next record takes: the number of records applied.
  next_sequence bigint NOT NULL CHECK (next_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The start of the log is the SDK's LOG_START, the empty cursor.
INSERT INTO derived_reader (id, cursor, next_sequence) VALUES (true, '', 0);

-- Every record the reader has applied, by its place in the deployment's total
-- order, counting from 0 (AD-16). Answers "has the copy reached this cursor",
-- and joins a relayed write's audit row to its record by operation id (NFR-7).
CREATE TABLE derived_log (
  sequence bigint PRIMARY KEY CHECK (sequence >= 0),
  cursor text NOT NULL UNIQUE,
  -- When the ledger recorded the input, by its clock: milliseconds since the epoch.
  recorded_at bigint NOT NULL,
  event_id text,
  event_sequence bigint CHECK (event_sequence >= 0),
  -- The command kind, or 'accessPass'.
  entry_kind text NOT NULL,
  -- A command's operation id; null for an access pass.
  operation_id text,
  -- When an access pass was presented, as its submitter claimed; null for a command.
  presented_at bigint,
  CHECK ((event_id IS NULL) = (event_sequence IS NULL)),
  CHECK ((entry_kind = 'accessPass') = (operation_id IS NULL))
);

CREATE INDEX derived_log_operation ON derived_log (operation_id);
CREATE INDEX derived_log_event ON derived_log (event_id, event_sequence);
