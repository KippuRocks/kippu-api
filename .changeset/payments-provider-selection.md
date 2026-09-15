---
"@kippurocks/api": patch
---

Explicit payment provider selection (follow-up to `T-022-04`). `KIPPU_PAYMENTS_PROVIDER=test|bloque` is required in `staging` and `production`, with no default. `test` is allowed in `development`, `test` and `staging`, where it mounts the testing payments route; it is refused in `production` and whenever Bloque credentials are set. Production uses `bloque`. No router changes.
