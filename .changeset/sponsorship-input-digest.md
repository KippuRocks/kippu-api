---
"@kippurocks/sponsorship": minor
---

Sponsorships also bind the signed input's digest — BLAKE2b-256 of the profile's signed-input framing, as `C3` records it — and `verifySponsorship` refuses a sponsorship attached to a different input that reuses its id. The format changes: a sponsorship issued before this version does not decode.
