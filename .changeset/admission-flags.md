---
"@kippurocks/api": minor
---

Provisional-admission flags (`T-025-06`). `derived.admissionFlags.list({ event })`, for the organiser, returns the event's flagged admission reports in the order received: each provisional admission the ledger refused, with its cause — `same-pass-at-two-gates`, `transfer-before-recording`, `gate-clock-outside-tolerance`, or `unexplained` — and each report from a gate whose clock was more than 10 s from Kippu's. A flag carries the report's gate, operator, ticket, pass and times, the clock drift, the other reports for the same pass, and the transfers that explain it, with the copy's freshness.
