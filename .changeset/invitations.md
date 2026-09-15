---
"@kippu/api": minor
---

Invitations (`T-021-12`). `events.invitations.create` (organiser) creates an invitation to a granted class at a placement, with an optional guest note kept in Kippu, and returns its token once. `events.invitations.list` lists an event's invitations, optionally by class, with their status, redeeming holder and ticket. `events.invitations.redeem` (holder session) issues the class's ticket to the linked account, once: an unknown token is `NOT_FOUND`, a redeemed one `CONFLICT`.
