---
"@kippurocks/api": minor
---

Operator accounts (`T-024-01`). An organiser creates named operators (`operators.create`), lists them with their live session count (`operators.list`), issues a one-time enrolment code for one (`operators.issueEnrolmentCode`, which answers the code once, with its expiry an hour later), and revokes every session of an operator at once (`operators.revokeSessions`), which also voids their unredeemed codes. Iriguchi redeems the code with `auth.operator.redeemEnrolmentCode`, unchanged. An operator of another organiser is `NOT_FOUND` with `error.data.reason` `unknown-operator`. New exported types: `CreateOperatorInput`, `EnrolmentCode`, `OperatorAccount`, `OperatorInput`, `OperatorRefusal`, `RevokedSessions`.
