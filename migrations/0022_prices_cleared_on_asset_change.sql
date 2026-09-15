-- Prices cleared when the sale asset changes (follow-up to T-021-14;
-- features/021-events-and-authority/plan.md "Prices").
--
-- A price is an integer in its asset's minor units, so changing the asset clears
-- every Purchased class's price rather than letting it change meaning (COPM/2 to
-- DUSD/6 is a factor of 10^4). A Purchased class may therefore be unpriced until
-- the organiser re-prices it; the event is not on sale meanwhile. Kippu still
-- refuses to define a Purchased class without a price. A Granted class never has one.

ALTER TABLE ticket_classes DROP CONSTRAINT ticket_classes_price_by_provenance;
ALTER TABLE ticket_classes ADD CONSTRAINT ticket_classes_granted_unpriced
  CHECK (provenance = 'Purchased' OR price IS NULL);
