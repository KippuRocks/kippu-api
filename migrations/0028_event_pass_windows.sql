-- Per-event pass window (T-021-15; NFR-5, REQ-AP-3;
-- features/021-events-and-authority/plan.md "Pass window").
--
-- How long an access pass Saifu produces for an event stays valid, set by the
-- organiser between 10 seconds and the ledger's maximum pass window. The ledger
-- enforces only the deployment maximum, so a per-event window is Kippu's
-- setting, not a ledger fact. An event with no row uses the default, 60 seconds.

CREATE TABLE event_pass_windows (
  event text PRIMARY KEY CHECK (event ~ '^[0-9a-f]{64}$'),
  -- Milliseconds. The upper bound is the ledger's configuration, checked by Kippu.
  window_ms integer NOT NULL CHECK (window_ms >= 10000),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  set_request_id text NOT NULL,
  set_at timestamptz NOT NULL
);
