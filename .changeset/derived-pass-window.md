---
"@kippurocks/api": minor
---

Pass windows in public and holder reads (`T-025-11`). Every `EventView` — from `derived.events.get`, `derived.events.onSale`, `derived.events.mine`, and each holding's event in `derived.holdings.mine` — carries `passWindow: { windowMs, isDefault }`: how long an access pass for the event stays valid, as its organiser set it, or the 60-second default. Saifu produces passes with it.
