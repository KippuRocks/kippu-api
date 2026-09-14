-- Granted issuance (T-021-05; US-B2, REQ-TC-4, REQ-TC-5).
--
-- One row per granted ticket Kippu has undertaken to issue, written before the
-- issuance is signed. A class quota counts every row not refused by the ledger
-- (ERR-ClassQuotaExceeded is a platform error, SPEC.md §10 note), and rows are
-- counted under a lock on the class, so concurrent issuances never exceed it.
-- The ledger stays authoritative for whether the ticket exists (REQ-IX-1).
--
-- A granted ticket is free at every layer (REQ-TC-4): there is no payment record
-- of any kind for it, here or anywhere — no amount, no charge, no invoice.

CREATE TABLE granted_issuances (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  class_id text NOT NULL REFERENCES ticket_classes (id),
  -- The TicketId the SDK derived through the profile; set once the issuance is assembled.
  ticket text CHECK (ticket ~ '^[0-9a-f]{64}$'),
  holder text NOT NULL CHECK (holder ~ '^[0-9a-f]{64}$'),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  request_id text NOT NULL,
  -- pending: undertaken; settled: the ledger recorded the ticket; rejected: the ledger
  -- refused it, and it no longer counts against the quota; failed: no verdict came back,
  -- and it still counts, since the ticket may exist.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'settled', 'rejected', 'failed')),
  operation_id text UNIQUE,
  receipt_cursor text,
  error_code text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((status = 'settled') = (receipt_cursor IS NOT NULL)),
  CHECK ((status = 'rejected') = (error_code IS NOT NULL)),
  CHECK ((status = 'pending') = (completed_at IS NULL))
);

CREATE INDEX granted_issuances_counted ON granted_issuances (class_id) WHERE status <> 'rejected';
