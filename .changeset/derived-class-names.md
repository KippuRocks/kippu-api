---
"@kippurocks/api": minor
---

Class legibility in holdings (follow-up to `T-025-05`). Each `TicketView` in `derived.holdings.mine` gains `kippuClass: { name } | null` — Kippu's own definition of the ticket's class — alongside the class document, so a class is legible through Kippu before an organiser writes a document (`AC-B2.6`). `null` when Kippu defines no class with that id for the ticket's event.
