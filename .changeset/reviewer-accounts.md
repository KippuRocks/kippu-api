---
"@kippu/api": minor
---

Reviewer accounts (`T-021-16`). Kippu operations reviewers enrol with `reviewers.enrolment.begin` / `.complete` — the one-time code the command line issued, their email and a passkey on the login RP id — and sign in with `reviewers.signIn.begin` / `.complete`, for 12-hour sessions. `SessionInfo.principal` gains `{ kind: "reviewer", reviewerId }`. Reviewer types are exported.
