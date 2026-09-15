-- Admission reports (T-024-04; REQ-OP-3, F-024 plan §5.3).
--
-- After each verdict at a gate, Iriguchi reports it: the event, gate, ticket and
-- pass, the verdict, and — for an admission — how its direct submission to the
-- ledger ended (REQ-CL-3). F-025 matches reports against the ledger's outcomes to
-- flag refused provisional admissions to the organiser (T-025-06).
--
-- A report is evidence for the organiser, never a ledger fact (REQ-IX-1): every
-- time and outcome in it is as the gate claims. received_at is Kippu's own clock,
-- so a gate clock drifting from it can be flagged (F-025 plan §5.5).

CREATE TABLE admission_reports (
  -- The order reports were received in, for readers that page through them.
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Chosen by Iriguchi, so a report sent again is recorded once.
  report_id uuid NOT NULL UNIQUE,
  operator_id uuid NOT NULL REFERENCES operators (id),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  session_id uuid NOT NULL,
  request_id text NOT NULL,
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  gate text NOT NULL CHECK (length(gate) BETWEEN 1 AND 100),
  ticket text NOT NULL CHECK (ticket ~ '^[0-9a-f]{64}$'),
  pass_id text NOT NULL CHECK (pass_id ~ '^[0-9a-f]{32}$'),
  verdict text NOT NULL CHECK (verdict IN ('admitted', 'refused')),
  -- The reason the gate showed, for a refusal: a §10 code or a platform reason.
  refusal text CHECK (length(refusal) BETWEEN 1 AND 64),
  -- When the pass was presented, as the gate submitted it (presentedAt).
  presented_at timestamptz NOT NULL,
  -- The gate device's own clock when it sent the report.
  device_clock timestamptz NOT NULL,
  -- How an admission's submission ended: settled with a receipt, rejected with a
  -- §10 code, or failed with no verdict. A refusal is never submitted.
  submission text CHECK (submission IN ('settled', 'rejected', 'failed')),
  receipt_cursor text CHECK (length(receipt_cursor) <= 256),
  error_code text CHECK (error_code ~ '^ERR-[A-Z][A-Za-z]*$'),
  received_at timestamptz NOT NULL,
  CHECK ((verdict = 'refused') = (refusal IS NOT NULL)),
  CHECK ((verdict = 'admitted') = (submission IS NOT NULL)),
  CHECK ((submission = 'settled') = (receipt_cursor IS NOT NULL)),
  CHECK ((submission = 'rejected') = (error_code IS NOT NULL)),
  CHECK (submission IS NOT NULL OR (receipt_cursor IS NULL AND error_code IS NULL))
);

-- F-025's matching: every report for a pass, and an event's reports in order.
CREATE INDEX admission_reports_pass ON admission_reports (pass_id, seq);
CREATE INDEX admission_reports_event ON admission_reports (event, seq);
