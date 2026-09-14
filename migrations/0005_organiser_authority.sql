-- Organiser authority (T-021-01; REQ-OA-1, NFR-7).
--
-- Kippu holds and exercises each organiser's authority over their events on the
-- ledger. Each organiser has one p256 key of their own, held in a KMS
-- (features/021-events-and-authority/plan.md §5.1). This table holds the key's
-- reference in the KMS and public facts about it, never secret key material:
-- keys stay in the KMS, and out of the application database (PLAN.md §3.5).
--
-- Every signature by the key is attributable. A signed command has its
-- audit_log row written first (NFR-7). The key's one other signature, its
-- self-registration (REQ-CP-6), is made only once this row exists, and is
-- attributed to the request recorded here.

CREATE TABLE organiser_ledger_accounts (
  organiser_id uuid PRIMARY KEY REFERENCES organisers (id),
  kms_key_ref text NOT NULL UNIQUE,
  public_key bytea NOT NULL UNIQUE CHECK (length(public_key) = 33),
  account text NOT NULL UNIQUE CHECK (account ~ '^[0-9a-f]{64}$'),
  -- The request that caused the key to be created.
  provisioned_request_id text NOT NULL,
  provisioned_principal_kind text NOT NULL,
  provisioned_session_id uuid,
  created_at timestamptz NOT NULL,
  -- The key's self-registration: public bytes, signed after this row was written.
  registration bytea,
  registration_signed_at timestamptz,
  -- When the ledger accepted the registration, so the account can sign commands.
  registered_at timestamptz,
  CHECK ((registration IS NULL) = (registration_signed_at IS NULL)),
  CHECK (registered_at IS NULL OR registration IS NOT NULL)
);
