-- Reviewer accounts (T-021-16; REQ-EV-6, NFR-7;
-- features/021-events-and-authority/plan.md §5.4, "Reviewers").
--
-- A reviewer is a Kippu operations account of its own kind, never an organiser,
-- so no reviewer reviews their own event. Reviewers are created and disabled only
-- from the command line, by someone with deployment access: there is no admin
-- surface in V0. Creating one issues a one-time enrolment code, redeemed with the
-- reviewer's email and a passkey on Kippu's login RP id, as an organiser signs up.
-- Reviewer sessions last 12 hours; disabling a reviewer ends them.

CREATE TABLE reviewers (
  id uuid PRIMARY KEY,
  -- An identifier, not verified in V0, as an organiser's.
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  created_at timestamptz NOT NULL,
  enrolled_at timestamptz,
  disabled_at timestamptz
);

-- One-time enrolment codes, stored hashed. Redeemed once; void once the reviewer is disabled.
CREATE TABLE reviewer_enrolment_codes (
  code_hash bytea PRIMARY KEY,
  reviewer_id uuid NOT NULL REFERENCES reviewers (id),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL
);

-- The passkeys a reviewer attested, on the login RP id. Never holder credentials.
CREATE TABLE reviewer_passkeys (
  credential_id text PRIMARY KEY,
  reviewer_id uuid NOT NULL REFERENCES reviewers (id),
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL CHECK (sign_count >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  last_used_at timestamptz
);

CREATE INDEX reviewer_passkeys_reviewer ON reviewer_passkeys (reviewer_id);

-- A reviewer's WebAuthn challenge not yet answered; consumed by the first answer.
CREATE TABLE reviewer_ceremonies (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('reviewer-enrolment', 'reviewer-sign-in')),
  challenge text NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES reviewers (id),
  -- The enrolment code the ceremony redeems, once it completes.
  code_hash bytea REFERENCES reviewer_enrolment_codes (code_hash),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK ((kind = 'reviewer-enrolment') = (code_hash IS NOT NULL))
);

-- Sessions gain the reviewer principal: no organiser, operator or holder.
ALTER TABLE sessions ADD COLUMN reviewer_id uuid REFERENCES reviewers (id);
ALTER TABLE sessions DROP CONSTRAINT sessions_principal_kind_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_principal_kind_check
  CHECK (principal_kind IN ('organiser', 'operator', 'holder', 'reviewer'));
ALTER TABLE sessions DROP CONSTRAINT sessions_principal_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_principal_check CHECK (
  CASE principal_kind
    WHEN 'organiser' THEN organiser_id IS NOT NULL AND operator_id IS NULL
      AND holder_account IS NULL AND reviewer_id IS NULL
    WHEN 'operator' THEN organiser_id IS NOT NULL AND operator_id IS NOT NULL
      AND holder_account IS NULL AND reviewer_id IS NULL
    WHEN 'holder' THEN organiser_id IS NULL AND operator_id IS NULL
      AND holder_account IS NOT NULL AND reviewer_id IS NULL
    WHEN 'reviewer' THEN organiser_id IS NULL AND operator_id IS NULL
      AND holder_account IS NULL AND reviewer_id IS NOT NULL
  END
);

-- The audit log can attribute a write to a reviewer: an approved capacity increase.
ALTER TABLE audit_log ADD COLUMN reviewer_id uuid;
