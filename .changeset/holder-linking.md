---
"@kippu/api": minor
---

Holder linking by proof of control (`T-020-06`). `auth.holder.beginLink` returns a proof-of-control challenge (audience, nonce, expiry and account, with bytes as hex). `auth.holder.completeLink` takes the holder credential's authorisation over it, as hex, and returns a 30-day holder session. `SessionInfo.principal` gains `{ kind: "holder", account }`. Every refusal is the same `UNAUTHORIZED`.
