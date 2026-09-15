-- The pass's holder in admission reports (F-024 plan §5.4, F-025 plan §5.5; T-025-12).
--
-- The account the pass designates, as the gate read it from the pass. It is
-- public — any pass shows it — and not personal data (NFR-6). A refused pass is
-- never recorded, so F-025's transfer cause is keyed on it: a transfer that moved
-- the ticket away from this holder. Reports sent before gates carried it have none.

ALTER TABLE admission_reports ADD COLUMN holder text CHECK (holder ~ '^[0-9a-f]{64}$');
