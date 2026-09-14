-- Organiser and operator authentication, and sessions (T-020-05).
--
-- Kippu facts only: none of these is a ledger fact, and an operator is never
-- known to the ledger (REQ-OP-1).

-- One Kippu account per organiser in V0. The email is an identifier, stored
-- normalised to lower case, and is not verified in V0.
CREATE TABLE organisers (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The passkey attested at sign-up, on Kippu's login RP id. It is never a
-- holder credential and can never authorise a ledger operation.
CREATE TABLE organiser_passkeys (
  credential_id text PRIMARY KEY,
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX organiser_passkeys_organiser ON organiser_passkeys (organiser_id);

-- A WebAuthn challenge Kippu issued and has not yet seen answered. Each is
-- consumed by the first attempt to answer it, successful or not.
CREATE TABLE webauthn_ceremonies (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('organiser-sign-up', 'organiser-sign-in')),
  challenge text NOT NULL,
  organiser_id uuid NOT NULL,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Operators exist under an organiser. Their profile, grants and the issuing of
-- enrolment codes belong to F-024.
CREATE TABLE operators (
  id uuid PRIMARY KEY,
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operators_organiser ON operators (organiser_id);

-- A one-time enrolment code, stored hashed. Redeeming it opens an operator
-- session; it cannot be redeemed twice.
CREATE TABLE operator_enrolment_codes (
  code_hash bytea PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES operators (id),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sessions are opaque bearer tokens; only their SHA-256 is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  principal_kind text NOT NULL CHECK (principal_kind IN ('organiser', 'operator')),
  organiser_id uuid NOT NULL REFERENCES organisers (id),
  operator_id uuid REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((principal_kind = 'operator') = (operator_id IS NOT NULL))
);

CREATE INDEX sessions_operator ON sessions (operator_id) WHERE operator_id IS NOT NULL;
