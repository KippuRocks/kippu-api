---
"@kippurocks/api": minor
---

A refused call can carry a machine-readable platform reason in `error.data.reason` (`null` otherwise), beside `error.data.errorCode`. `events.invitations.redeem` documents its reasons as `InvitationRefusal`: `unknown-invitation`, `already-redeemed`, `seat-held`, `seat-taken`, `sold-out` and `class-sold-out`, so Saifu can tell a holder which applies. Transport codes are unchanged.
