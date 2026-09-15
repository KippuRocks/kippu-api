---
"@kippurocks/api": minor
---

Operator grants (`T-024-02`). An organiser grants one of their operators gates of an event they own for a window (`operators.grants.create({ operator, event, gates, from, until })`, Unix milliseconds, `until` exclusive), lists grants by event and operator (`operators.grants.list`), and revokes one (`operators.grants.revoke({ grant })`; revoking again changes nothing). The event's owner is read from the ledger — `ERR-EventNotFound`, `ERR-NotOwner` — and nothing is written to it (`AC-E5.1`). An operator reads their own grants not revoked and not ended with `operators.grants.mine`, for Iriguchi's event and gate choice. A grant of another organiser is `NOT_FOUND` with reason `unknown-grant`. New exported types: `GrantIdInput`, `GrantInput`, `ListGrantsInput`, `OperatorGrant`.
