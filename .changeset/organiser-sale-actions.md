---
"@kippurocks/api": minor
---

Holds against organiser actions (`T-022-05`, `REQ-HD-4`). The sales services expose `organiserActions` for `F-021`: `canDecreaseCapacity(event, to)` — issued tickets plus holds not yet issued at most `to`; `releaseAll(event, cause)` — closes the event's sales, releases every outstanding hold, cancels open hosted checkouts, and records a refund entitlement (`event-closed`) for any payment already taken against a released hold; `reopenSales` when the organiser's write is refused. While sales are closed, `sales.checkout.begin`, `hold` and `pay` are refused with `CONFLICT`, and `sales.inventory` reports the event not on sale. `CheckoutRefund.reason` gains `event-closed`.
