---
"@kippurocks/api": minor
---

Issuance holds (`T-022-03`). `sales.checkout.hold` places a linked checkout's hold before any payment: in one transaction it is counted against the event's capacity (with the tickets already issued), the class's quota and, in a seated zone, the seat — locked and checked through `F-021`'s seat allocation, then against other outstanding holds. When any is exhausted the answer is `{ outcome: "refused", reason }`, with `sold-out`, `class-sold-out` or `seat-taken`. A checkout with no holder account is `PRECONDITION_FAILED`; one whose hold lapsed or was released is `CONFLICT`. A hold lives 10 minutes, extendable once by 5 when payment starts; `Checkout.hold` shows its status, expiry and extension. New exported types: `CheckoutHold`, `HoldOutcome`, `HoldRefusal`, `HoldStatus`.
