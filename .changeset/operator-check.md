---
"@kippurocks/api": minor
---

The operator authorisation check (`T-024-03`). `operators.check({ event, gate })`, in an operator session, answers whether the operator may admit at that gate now: `{ event, gate, grant, until, checkedAt }`, with Kippu's clock in `checkedAt`. Otherwise it is `FORBIDDEN` with a `CheckRefusal` in `error.data.reason` — `grant-revoked`, `before-window`, `after-window` or `not-granted`; a revoked or ended session is `UNAUTHORIZED`. Nothing is cached, so a revocation refuses the next check (`AC-E5.2`). Iriguchi runs it alongside `canAttend`. New exported types: `CheckInput`, `CheckRefusal`, `OperatorAuthorisation`.
