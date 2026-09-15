-- The derived copy's consumed passes (T-025-12; REQ-OP-3, NFR-11).
--
-- One row per access-pass record in the log: a pass the ledger accepted and
-- consumed, with its window as the holder signed it, when the gate claimed it was
-- presented, and when the ledger recorded it. F-025 reconciles admission reports
-- against it: a report whose submission failed is flagged only if its pass is
-- not recorded in time (F-025 plan §5.5). A pass's id is its operation id
-- (AD-15). Like the rest of the copy it is not authoritative (REQ-IX-1); it holds
-- identifiers and times only (NFR-6).

CREATE TABLE derived_passes (
  ticket_id text NOT NULL REFERENCES derived_tickets (id),
  pass_id text NOT NULL,
  event_id text NOT NULL REFERENCES derived_events (id),
  holder text NOT NULL,
  -- Milliseconds since the epoch: the window the holder signed.
  not_before bigint NOT NULL,
  not_after bigint NOT NULL,
  -- As the submitter claimed it (REQ-AP-3).
  presented_at bigint NOT NULL,
  -- By the ledger's clock.
  recorded_at bigint NOT NULL,
  sequence bigint NOT NULL UNIQUE REFERENCES derived_log (sequence),
  -- The ledger consumes a pass id at most once while it could still be recorded (INV-6).
  PRIMARY KEY (ticket_id, pass_id)
);
