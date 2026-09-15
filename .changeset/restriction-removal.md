---
"@kippu/api": minor
---

Restriction removal (`T-021-10`). `events.tickets.removeRestriction` removes `cannotResale` or `cannotTransfer` from a ticket of the organiser's event and answers with its restrictions as the ledger records them; removing `cannotResale` from a ticket that cannot be transferred removes both. `RemoveRestrictionInput` and `RestrictionRemoved` are exported.
