---
"@kippurocks/api": major
"@kippurocks/sponsorship": major
"@kippurocks/metadata-schema": major
---

**Breaking:** the published scope changed from `@kippu/*` to `@kippurocks/*`
(the npmjs organisation that exists, ruled by Pablo — `T-020-10`). Every
consumer that vendors these packages must re-vendor from this commit onward
and update its imports:

- `@kippu/api` → `@kippurocks/api`
- `@kippu/sponsorship` → `@kippurocks/sponsorship`
- `@kippu/metadata-schema` → `@kippurocks/metadata-schema`

No other change. Nothing is published to a registry in V0 (`M5`); this
records the rename for when publishing starts.
