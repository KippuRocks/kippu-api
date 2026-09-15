---
"@kippu/api": patch
---

Granted issuance and invitation redemption count checkouts' outstanding holds (`T-021-13`): a seat a buyer holds is refused with `CONFLICT`, and a last place or class quota taken by holds with `ERR-CapacityExceeded` or `ERR-ClassQuotaExceeded`, before submission.
