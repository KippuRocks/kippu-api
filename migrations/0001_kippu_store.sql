-- The Kippu store.
--
-- Kippu's own facts live here: identity, sessions, the audit log, holds, and
-- the derived copy of the ledger. No table in this store is authoritative for
-- a fact SPEC.md §4.2 assigns to Ticketto (REQ-IX-1): where a copy of one is
-- kept, the ledger wins. This database is a separate PostgreSQL instance from
-- the ledger service's store, with separate credentials (AD-20, REQ-SDK-9).
--
-- Migrations are append-only: never edit one that has been merged.

COMMENT ON SCHEMA public IS
  'Kippu store. Not authoritative for any Ticketto fact (REQ-IX-1); separate from the ledger service store (REQ-SDK-9).';
