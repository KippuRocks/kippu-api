-- Organiser ledger accounts, for the sponsor relay (T-023-09; REQ-SP-3, REQ-OA-1).
--
-- Kippu holds every organiser's authority on the ledger, and no one else creates
-- events at Kippu's expense: the relay sponsors createEvent only for an organiser
-- account. It reads the account ids through this view, and nothing else of
-- organiser_ledger_accounts — no organiser id, key reference, public key or
-- provisioning record. Account ids are public ledger identifiers, not personal
-- data (NFR-6).
--
-- The view runs with its owner's privileges, so the relay's reader role holds
-- SELECT on the view alone and none on the table beneath it.
CREATE VIEW sponsor_relay_organiser_accounts AS
  SELECT account FROM organiser_ledger_accounts;

GRANT SELECT ON sponsor_relay_organiser_accounts TO kippu_sponsor_relay_reader;
