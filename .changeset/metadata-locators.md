---
"@kippurocks/metadata-schema": minor
---

Metadata locators (`T-026-03`, `REQ-MD-1`). `eventLocator(eventId)` is the locator an event's document lives at, `https://meta.kippu.rocks/v0/events/<EventId>.json`, recorded on the ledger when the event is created. `classLocator(classId)` derives a ticket class's document locator, `https://meta.kippu.rocks/v0/classes/<ClassId>.json`, from the class id a ticket carries. Both take an optional origin for a local stand-in; `METADATA_ORIGIN` is the default.
