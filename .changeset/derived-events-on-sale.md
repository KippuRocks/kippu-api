---
"@kippu/api": minor
---

Public index of events on sale (`T-025-10`). `derived.events.onSale({ limit?, page? })`, public, lists `Active` events that have a `Purchased` class, most recently created first, each as `derived.events.get` returns it — ledger facts, metadata locator and document. `limit` is 1–100, default 20; pass `nextPage` back as `page` to continue, until it is `null`. Cancelled, finished and sealed events are not listed. A page token the index did not issue is a `BAD_REQUEST`.
