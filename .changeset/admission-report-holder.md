---
"@kippu/api": minor
---

Admission reports carry the pass's holder (`T-025-12`). `operators.reportAdmission` accepts an optional `holder`, the account the pass designates (64 lower-case hex), read from the pass; the stored report returns it. The `transfer-before-recording` flag now needs it: a refusal as `ERR-InvalidPass` is explained by a transfer away from that holder, recorded no earlier than `presentedAt` less 10 seconds. A report without a holder cannot raise that cause, and is flagged `unexplained`.
