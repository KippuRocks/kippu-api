---
"@kippu/api": minor
---

Metadata editing (`T-026-04`). `metadata.events.put` writes an event's public document and `metadata.classes.put` a ticket class's, each validated whole against the schema it declares and stored at its locator, which never changes; both answer with the locator and the stored object's `ETag`. No edit writes to the ledger. A document that does not conform, or names another event or class, is a `BAD_REQUEST`; another organiser's event is refused with `ERR-NotOwner`, and a class the event does not have with `ERR-UnknownClass`.
