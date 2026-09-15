-- Scheduled Finished, and Kippu acting on its own (T-021-09; REQ-EV-12, NFR-7;
-- features/021-events-and-authority/plan.md §5.5).
--
-- Finished is set by the organiser, through Kippu; Kippu may set it on their
-- behalf at a time they choose (REQ-EV-12). Off unless the organiser schedules
-- it; a notice is due 24 hours before; cancellable until it runs. One schedule
-- per event: rescheduling replaces it.
--
-- The write it causes has no user or session behind it. It is audited with the
-- system principal, attributed to the organiser who scheduled it, with request
-- id "scheduled-finish:<schedule id>".

CREATE TABLE finish_schedules (
  id uuid PRIMARY KEY,
  event text NOT NULL UNIQUE CHECK (event ~ '^[0-9a-f]{64}$'),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  finish_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'finished', 'refused', 'cancelled')),
  -- When the organiser was noticed that the event will finish (24 hours before).
  noticed_at timestamptz,
  error_code text,
  set_request_id text NOT NULL,
  set_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK ((status = 'refused') = (error_code IS NOT NULL)),
  CHECK ((status IN ('scheduled', 'running')) = (ended_at IS NULL))
);

CREATE INDEX finish_schedules_due ON finish_schedules (finish_at) WHERE status = 'scheduled';

-- Kippu itself may close an event's sales before a scheduled Finished.
ALTER TABLE checkout_audit DROP CONSTRAINT checkout_audit_actor_check;
ALTER TABLE checkout_audit ADD CONSTRAINT checkout_audit_actor_check CHECK (actor IN (
  'anonymous', 'organiser', 'operator', 'holder', 'payment-provider', 'sweep', 'system'
));
