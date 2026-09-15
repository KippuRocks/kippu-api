---
"@kippurocks/api": minor
---

Failed submissions reconciled in admission flags (`T-025-12`). A report whose submission failed is no longer ignored: it is flagged with the new cause `not-recorded` once the ledger, by its clock as Kippu's copy has read it, can no longer record the pass and the copy holds no record of it; it is never flagged if the pass is recorded, however late. `AdmissionFlag` gains `recordingDeadline`, the ledger time after which the pass could no longer be recorded, for `not-recorded` flags.
