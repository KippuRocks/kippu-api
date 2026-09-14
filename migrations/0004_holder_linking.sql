-- Holder linking by proof of control (T-020-06), and holder sessions.
--
-- A holder is linked to one ledger AccountId by proving control of a holder
-- credential registered to it. Kippu holds nothing that can sign (REQ-SP-4):
-- only the account id, which is public, is stored.

CREATE TABLE holders (
  account text PRIMARY KEY CHECK (account ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  last_linked_at timestamptz NOT NULL
);

-- A proof-of-control challenge Kippu issued. Its nonce is consumed by the first
-- attempt to answer it, successful or not.
CREATE TABLE holder_link_challenges (
  id uuid PRIMARY KEY,
  account text NOT NULL CHECK (account ~ '^[0-9a-f]{64}$'),
  nonce bytea NOT NULL UNIQUE CHECK (length(nonce) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

-- Sessions gain the holder principal. A holder session names its account and
-- no organiser.
ALTER TABLE sessions DROP CONSTRAINT sessions_principal_kind_check;
ALTER TABLE sessions DROP CONSTRAINT sessions_check;
ALTER TABLE sessions ALTER COLUMN organiser_id DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN holder_account text REFERENCES holders (account);
ALTER TABLE sessions ADD CONSTRAINT sessions_principal_kind_check
  CHECK (principal_kind IN ('organiser', 'operator', 'holder'));
ALTER TABLE sessions ADD CONSTRAINT sessions_principal_check CHECK (
  CASE principal_kind
    WHEN 'organiser' THEN organiser_id IS NOT NULL AND operator_id IS NULL AND holder_account IS NULL
    WHEN 'operator' THEN organiser_id IS NOT NULL AND operator_id IS NOT NULL AND holder_account IS NULL
    WHEN 'holder' THEN organiser_id IS NULL AND operator_id IS NULL AND holder_account IS NOT NULL
  END
);

-- The audit log can attribute a write to a holder principal too.
ALTER TABLE audit_log ADD COLUMN holder_account text;
