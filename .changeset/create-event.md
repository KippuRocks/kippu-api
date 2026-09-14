---
"@kippu/api": minor
---

Event creation (`T-021-02`). `events.create` takes zones (id and kind) and an optional capacity, creates the event on the ledger owned by the organiser's account, and answers with the event's id and the receipt's log cursor. A ledger refusal, such as `ERR-ZoneExists`, carries its §10 code.
