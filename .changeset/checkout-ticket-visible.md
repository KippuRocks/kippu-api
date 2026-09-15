---
"@kippurocks/api": minor
---

Checkout confirmation freshness (follow-up to `T-022-04`). `Checkout` gains `ticketVisible`: true once Kippu's derived copy has passed the sale's issuance receipt (`NFR-11`), so Ichiba says "your ticket is in Saifu" only when Saifu will show it. `sales.checkout.get` takes an optional `waitForTicketMs` (at most 10,000) to wait for it once the sale is issued. No public `waitFor` is exposed. New exported type: `GetCheckoutInput`.
