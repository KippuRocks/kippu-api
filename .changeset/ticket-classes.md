---
"@kippurocks/api": minor
---

Ticket classes (`T-021-04`). `events.classes.define` defines a class for an event the organiser owns — name, description, provenance, attendance policy, restrictions and quota — and returns it with its opaque 32-byte class id. A class declared `Purchased` with a restriction is refused with `ERR-RestrictionNotPermitted`. `events.classes.list` lists an event's classes. Both refuse with `ERR-EventNotFound` or `ERR-NotOwner`.
