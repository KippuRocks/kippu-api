---
"@kippurocks/api": minor
---

Sale assets and prices (`T-021-14`). `events.create` takes an optional `saleAsset` (`COPM/2` or `DUSD/6`); `events.setSaleAsset` sets it later, refused with `CONFLICT` once the event has had a hold or a sale, and `events.saleAsset` reads it. A `Purchased` class needs a `price` — a positive integer in the asset's minor units — at definition, and `events.classes.setPrice` changes it for holds placed afterwards; a `Granted` class has none. `sales.inventory` gains `asset` and each class's `price`, and is on sale only once an asset is chosen. The event and class input and output types are exported.
