---
"@kippu/api": minor
---

Read routers over Kippu's derived copy (`T-025-05`). `derived.events.get` (public) returns an event as one object of ledger facts and its metadata document; `derived.events.mine` (organiser) lists the events the organiser owns, newest first; `derived.holdings.mine` (holder) lists the holder's tickets, each with its class document and its event; `derived.waitFor` (signed in) waits up to 10 s until the copy reflects a write's receipt cursor. Every view is marked `authoritative: false` with the log sequence that last changed it, and every response carries the copy's freshness. A document is `null` when Kippu hosts none at the locator.
