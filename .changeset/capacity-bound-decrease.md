---
"@kippurocks/api": patch
---

Bounding an event that has no capacity is a decrease (follow-up to `T-021-07`): `events.decreaseCapacity` accepts any capacity on an unbounded event, down to its tickets issued plus outstanding holds, with no proof. `events.capacityProofs.request` refuses it with reason `not-an-increase`. Removing a bound is still an increase and needs an approved proof.
