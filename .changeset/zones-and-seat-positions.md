---
"@kippurocks/api": minor
---

Zones and canonical seat positions (`T-021-03`). `events.zones.add` and `events.zones.remove` add and remove an event's zones, passing on the ledger's `ERR-ZoneExists`, `ERR-ZoneInUse` and status refusals. `events.zones.addSeatPositions` uploads a seated zone's canonical positions — kept once each, matched exactly — and `events.zones.seatPositions` lists them. Positions for an unseated or unknown zone are refused with `ERR-ZoneKindMismatch` or `ERR-UnknownZone`.
