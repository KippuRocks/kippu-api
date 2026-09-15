---
"@kippu/api": minor
---

Per-event pass window (`T-021-15`). `events.passWindow` returns an event's pass window in milliseconds — 60 seconds until set — with the bounds it can be set within, and `events.setPassWindow` sets it between 10 seconds and the ledger's maximum pass window, refusing anything outside with `BAD_REQUEST`. Organiser only. `EventPassWindow` and `SetPassWindowInput` are exported.
