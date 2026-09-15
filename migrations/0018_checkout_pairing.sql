-- Handoff pairing and checkout lifetime (T-022-11; AC-B4.1, REQ-CL-4;
-- features/022-sales-and-holds/plan.md §5.1, as ruled in M2).
--
-- The handoff can be seen — on desktop it is a QR code — so it carries a token
-- of its own, apart from the checkout page's: whoever sees the handoff can link
-- an account, but cannot confirm the link, hold or pay. The handoff token is
-- derived from the page's token and a generation, so neither is stored. Saifu and the checkout
-- page both show a short pairing code derived from the handoff and the linked
-- account; the buyer confirms the match on the page before a hold is placed. A
-- discarded link frees the checkout and replaces the handoff token.
--
-- A checkout with no hold expires one hour after it began; a hold carries its
-- own lifetime (0017_holds).

ALTER TABLE checkout_sessions
  ADD COLUMN handoff_token_hash bytea CHECK (length(handoff_token_hash) = 32),
  -- Incremented each time a link is discarded, replacing the handoff token.
  ADD COLUMN handoff_generation integer NOT NULL DEFAULT 0 CHECK (handoff_generation >= 0),
  ADD COLUMN link_confirmed_at timestamptz,
  ADD COLUMN link_confirmed_request_id text;

-- Checkouts begun before pairing get a handoff no token names: they cannot be
-- handed off again. A link made with the buyer's own holder session at begin is
-- confirmed; any other is not.
UPDATE checkout_sessions SET handoff_token_hash = sha256(token_hash);
UPDATE checkout_sessions
  SET link_confirmed_at = linked_at, link_confirmed_request_id = linked_request_id
  WHERE created_principal_kind = 'holder' AND holder_account IS NOT NULL;

ALTER TABLE checkout_sessions
  ALTER COLUMN handoff_token_hash SET NOT NULL,
  ADD CONSTRAINT checkout_sessions_handoff_token_hash_key UNIQUE (handoff_token_hash),
  ADD CONSTRAINT checkout_sessions_confirmed_link
    CHECK (link_confirmed_at IS NULL OR holder_account IS NOT NULL),
  ADD CONSTRAINT checkout_sessions_confirmed_request
    CHECK ((link_confirmed_at IS NULL) = (link_confirmed_request_id IS NULL));

CREATE INDEX checkout_sessions_created ON checkout_sessions (created_at);
