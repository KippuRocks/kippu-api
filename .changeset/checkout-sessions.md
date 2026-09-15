---
"@kippu/api": minor
---

Checkout sessions (`T-022-02`). `sales.checkout.begin` begins a checkout for a ticket of a `Purchased` class — a zone, and a canonical seat in a seated zone — and returns its token once. With a holder session the checkout is linked to the holder's account at once; otherwise it carries a Saifu handoff (`AD-19` A), and Saifu links the account with `sales.checkout.link` in the holder's session. `sales.checkout.get` reads a checkout by its token. A not-`Active` event, an unknown class or zone, or a placement that does not fit the zone is refused with its §10 code; a `Granted` class or a non-canonical seat is a `BAD_REQUEST`; an unknown token is `NOT_FOUND`, and linking another account `CONFLICT`. The checkout types are exported: `BeginCheckoutInput`, `BegunCheckout`, `Checkout`, `CheckoutAccount`, `CheckoutTokenInput`, `SaifuHandoff`.
