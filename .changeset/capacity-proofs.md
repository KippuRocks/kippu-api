---
"@kippu/api": minor
---

Capacity proofs (`T-021-08`). `events.capacityProofs.request` asks for an increase in an event's capacity — or `null` to remove the bound — with an artefact (PDF, JPEG or PNG, at most 2 MiB) kept in Kippu's private storage; `events.capacityProofs.list` shows each request's review status. Kippu reviewers see `reviewers.capacityProofs.queue`, read an `artefact`, and `approve` or `reject`; an approval submits the increase with a random proof id, which the ledger records. `RequestCapacityIncreaseInput`, `CapacityProofRequest`, `ReviewedCapacityProofRequest`, `CapacityProofRequestInput`, `ProofArtefact`, `ProofArtefactInput`, `ProofArtefactMediaType` and `CapacityProofStatus` are exported.
