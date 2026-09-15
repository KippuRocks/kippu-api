---
"@kippu/api": minor
---

Admission reports (`T-024-04`). `operators.reportAdmission`, in an operator session, records a verdict at a gate for `F-025`'s provisional-admission flags (`REQ-OP-3`): `{ reportId, event, gate, ticket, passId, verdict, presentedAt, deviceClock }`, where `verdict` is `{ kind: "admitted", submission }` — `submission` settled with the receipt's `cursor`, rejected with the ledger's §10 `errorCode`, or `failed` — or `{ kind: "refused", reason }`. `reportId` is Iriguchi's own UUID: sending a report again answers the one first recorded, with Kippu's `receivedAt`. A gate of an event the operator was never granted is `FORBIDDEN`, reason `not-granted` (revoked and ended grants still accept reports); another operator's report id is `CONFLICT`, reason `report-exists`. New exported types: `AdmissionReport`, `AdmissionReportInput`, `AdmissionSubmission`.
