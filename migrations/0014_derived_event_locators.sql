-- The metadata locator each event carries on the ledger, in the derived copy
-- (T-025-05; AC-A3.2, REQ-MD-1).
--
-- createEvent records a stable locator on the ledger (REQ-MD-1). The reader
-- copies it from the log like any other ledger fact, so a read joins an event's
-- ledger facts with the document at the locator the ledger holds — including
-- for events Kippu never relayed. Null when the event was created with none.
-- Like the rest of the copy, it is not authoritative (REQ-IX-1).

ALTER TABLE derived_events ADD COLUMN metadata_locator text;
