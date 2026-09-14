---
"@kippu/api": minor
---

Granted issuance (`T-021-05`). `events.tickets.issueGranted` issues a ticket from a granted class to a holder's account — in a seated zone at one of its canonical positions, or unseated — and answers with the ticket id and the receipt's log cursor. Kippu refuses with `ERR-UnknownClass` or `ERR-ClassQuotaExceeded`; the ledger's refusals, such as `ERR-CapacityExceeded` and `ERR-TicketIdExists`, carry their §10 codes. A non-canonical seat, or a `Purchased` class, is a `BAD_REQUEST`.
