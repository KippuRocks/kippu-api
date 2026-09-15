-- Checkout sessions (T-022-02; US-B4, AC-B4.1, AD-19 A).
--
-- A checkout records what a buyer picked — an event, a zone, a Purchased class
-- and, in a seated zone, a seat — and the holder account the ticket will be
-- issued to. A ticket cannot be issued without a holder account (INV-2), and
-- only Saifu holds holder credentials (REQ-CL-2), so a checkout begun without
-- a holder session waits for Saifu to link one (features/022-sales-and-holds/
-- plan.md §5.1, step 2).
--
-- The checkout is named by an opaque token, shown once and stored hashed. The
-- only personal-looking datum is the holder's AccountId, which is public, and
-- nothing here reaches the ledger (NFR-6, AC-B4.2).

CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  event text NOT NULL CHECK (event ~ '^[0-9a-f]{64}$'),
  zone text NOT NULL CHECK (zone ~ '^[0-9a-f]{64}$'),
  class_id text NOT NULL REFERENCES ticket_classes (id),
  -- A canonical seat designation in a seated zone; NULL for general admission.
  position text CHECK (length(position) BETWEEN 1 AND 100),
  -- The holder account the ticket will be issued to, once linked (AC-B4.1).
  holder_account text REFERENCES holders (account),
  created_request_id text NOT NULL,
  created_principal_kind text NOT NULL
    CHECK (created_principal_kind IN ('anonymous', 'organiser', 'operator', 'holder')),
  created_at timestamptz NOT NULL,
  -- The holder session that linked the account, and by which request.
  linked_session_id uuid,
  linked_request_id text,
  linked_at timestamptz,
  CHECK ((holder_account IS NULL) = (linked_at IS NULL)),
  CHECK ((holder_account IS NULL) = (linked_request_id IS NULL)),
  CHECK ((holder_account IS NULL) = (linked_session_id IS NULL))
);
