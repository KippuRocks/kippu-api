---
"@kippurocks/api": patch
---

Primary checkout audit records (`T-022-09`). Every step of a checkout is recorded with the request that caused it and who made it, and a sale's issuance is joined to its audit-log row, so every primary sale is attributable end to end and primary checkout is distinguishable in the audit log (`REQ-MP-8`). No router changes.
