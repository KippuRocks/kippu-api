---
"@kippu/api": minor
---

Admission reports after a revocation (follow-up to `T-024-04`; `F-024` plan §5.4). An admission presented before a revocation is still evidence (`REQ-OP-3`). An operator session revoked within the last 24 hours — by `operators.revokeSessions`, or by signing out — may still call `operators.reportAdmission`, and nothing else, for a pass whose `presentedAt` precedes the revocation; any other report, and every other call from that session, is `UNAUTHORIZED`. Likewise a revoked grant accepts reports only for passes presented before its revocation; after it, a gate with no other grant covering the presentation is `FORBIDDEN` with the new reason `grant-revoked` in `OperatorRefusal`. Ended grants still accept reports.
