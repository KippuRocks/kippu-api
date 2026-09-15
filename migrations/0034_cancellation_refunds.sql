-- Cancellation refund entitlements (T-022-07; AC-A5.5, REQ-EV-10, DEF-12;
-- features/022-sales-and-holds/plan.md §5.5, "Cancellation refunds").
--
-- After an event is cancelled, every purchased ticket of it is owed a refund —
-- at most once per ticket (AC-A5.5). Each entitlement records the ticket's
-- original purchaser, who is refunded whatever transfers followed, and the
-- holder at cancellation as the ledger fixed it (REQ-EV-10); in V0 the latter is
-- recorded but decides nothing (DEF-12). Both are account ids: public, not
-- personal data (NFR-6). The amount is the ticket's face value.

ALTER TABLE refund_entitlements
  ADD COLUMN ticket text UNIQUE CHECK (ticket ~ '^[0-9a-f]{64}$'),
  ADD COLUMN purchaser_account text CHECK (purchaser_account ~ '^[0-9a-f]{64}$'),
  ADD COLUMN holder_at_cancellation text CHECK (holder_at_cancellation ~ '^[0-9a-f]{64}$');

ALTER TABLE refund_entitlements DROP CONSTRAINT refund_entitlements_reason_check;
ALTER TABLE refund_entitlements ADD CONSTRAINT refund_entitlements_reason_check CHECK (reason IN (
  'issuance-rejected', 'place-gone', 'amount-mismatch', 'event-closed', 'event-cancelled'
));
ALTER TABLE refund_entitlements ADD CONSTRAINT refund_entitlements_cancellation CHECK (
  (reason = 'event-cancelled') =
    (ticket IS NOT NULL AND purchaser_account IS NOT NULL AND holder_at_cancellation IS NOT NULL)
);
