---
"@kippurocks/api": minor
---

Public sale inventory (`T-022-10`). `sales.inventory({ event })`, with no session, answers whether the event is on sale, how many tickets can still be held — of the event and of each `Purchased` class — counting outstanding holds with the same accounting a hold uses, and each seated zone's free canonical seats, neither issued, being issued, nor held. `ERR-EventNotFound` for no such event. New exported types: `SaleInventory`, `SaleInventoryInput`, `ClassOnSale`, `ZoneOnSale`.
