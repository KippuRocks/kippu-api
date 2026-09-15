---
"@kippurocks/api": minor
---

Changing an event's sale asset from one asset to another clears every `Purchased` class's price, so a price never changes meaning. `EventSaleAsset` gains `unpriced`, the `Purchased` classes still to re-price. The event is not on sale — `sales.inventory` reports `onSale: false`, and holds are refused — until each is re-priced. `TicketClass.price` is `null` for a cleared class.
