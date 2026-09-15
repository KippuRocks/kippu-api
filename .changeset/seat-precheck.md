---
"@kippu/api": patch
---

Seated double-allocation pre-check (`T-021-06`). `events.tickets.issueGranted` refuses a seat already issued, or being issued, with `ERR-TicketIdExists` before anything is submitted. Seat designations are normalised to Unicode NFC before they are stored or matched, so visually identical spellings are one seat.
