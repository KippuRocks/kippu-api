---
"@kippu/api": minor
---

Cancellation refund entitlements (`T-022-07`, `AC-A5.5`). `organiserActions.recordCancellationRefunds(event, cause)`, once the event is `Cancelled` on the ledger, records one refund entitlement per purchased ticket — at most once — for its face value, owed to its original purchaser whatever transfers followed (`DEF-12`), with the holder at cancellation the ledger fixed (`REQ-EV-10`) recorded beside it. `CheckoutRefund.reason` gains `event-cancelled`.
