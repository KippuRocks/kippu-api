-- The derived copy's transfer history (T-025-06; REQ-OP-3, NFR-11).
--
-- One row per transferTicket record in the log: the ticket, the holder it left
-- and the holder it reached, and when the ledger recorded it. F-025 matches
-- admission reports against it: a pass refused as ERR-InvalidPass with a
-- transfer recorded between the gate's verdict and the refusal is flagged with
-- that cause (F-025 plan §5.5). Like the rest of the copy it is not
-- authoritative (REQ-IX-1), and it holds account ids only (NFR-6).

CREATE TABLE derived_transfers (
  sequence bigint PRIMARY KEY REFERENCES derived_log (sequence),
  event_id text NOT NULL REFERENCES derived_events (id),
  ticket_id text NOT NULL REFERENCES derived_tickets (id),
  from_holder text NOT NULL,
  to_holder text NOT NULL,
  -- When the ledger recorded the transfer, by its clock: milliseconds since the epoch.
  recorded_at bigint NOT NULL
);

CREATE INDEX derived_transfers_ticket ON derived_transfers (ticket_id, recorded_at);
