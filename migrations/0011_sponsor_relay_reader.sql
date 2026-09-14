-- Read-only access to the derived copy for the sponsor relay (T-023-02,
-- AD-18 A, NFR-4).
--
-- The relay is a separate process from kippu-api's business layer. It decides
-- entitlements from ledger facts (REQ-SP-3), and so reads the derived copy and
-- nothing else: no identity, sessions, audit log, organiser keys or classes,
-- and no write anywhere.
--
-- This role carries exactly that access and cannot log in. A deployment
-- creates the relay's own login role and grants it this one; the relay's
-- credentials are never kippu-api's. Roles belong to the whole PostgreSQL
-- cluster, so the role is created only if absent, and a concurrent creation by
-- another database's migration is tolerated.
DO $$
BEGIN
  CREATE ROLE kippu_sponsor_relay_reader NOLOGIN;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

GRANT SELECT ON derived_reader, derived_log, derived_events, derived_tickets, derived_attendance
  TO kippu_sponsor_relay_reader;
