---
"@kippu/api": minor
---

Capacity decrease (`T-021-07`). `events.decreaseCapacity` lowers an event's capacity down to its tickets issued plus outstanding holds, refusing anything lower with `ERR-CapacityBelowIssuance` (reason `held` when holds make the difference) and any increase with `ERR-CapacityProofRequired`. `DecreaseCapacityInput` and `CapacityChanged` are exported.
