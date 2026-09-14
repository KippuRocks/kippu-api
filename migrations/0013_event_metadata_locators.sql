-- The metadata locator each event was created with (T-026-03; REQ-MD-1, AD-22).
--
-- The locator is recorded on the ledger by createEvent, and never changes: an
-- edit to the event's document rewrites the object at this locator. Kept here
-- so the document is written where the ledger points, whatever the configured
-- public origin is later. Null only for an event created before locators were
-- allocated.

ALTER TABLE organiser_events ADD COLUMN metadata_locator text
  CHECK (metadata_locator ~ '^https://[^/]+/v0/events/[0-9a-f]{64}\.json$');
