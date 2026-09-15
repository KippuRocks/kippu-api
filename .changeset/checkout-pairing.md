---
"@kippu/api": minor
---

Handoff pairing and checkout lifetime (`T-022-11`). **Breaking for the handoff:** a Saifu handoff now carries a `handoffToken` of its own, apart from the checkout page's `token`; `sales.checkout.link` takes `{ handoffToken }` and answers with a `HandoffLink` — what is being bought and a 6-digit `pairingCode`. The checkout's account goes `handoff` → `pairing` (showing the same code) → `linked` once the buyer confirms on the checkout page with `sales.checkout.confirmLink({ token, pairingCode })`; `sales.checkout.discardLink({ token })` discards an unconfirmed link and replaces the handoff token. `sales.checkout.hold` needs a confirmed link (`PRECONDITION_FAILED` otherwise). A checkout with no hold expires an hour after it began (`Checkout.expiresAt`), and is then `NOT_FOUND`. New exported types: `ConfirmLinkInput`, `HandoffLink`, `HandoffTokenInput`.
