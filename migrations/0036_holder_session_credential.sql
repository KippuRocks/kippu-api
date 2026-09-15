-- The holder credential a holder session was linked with (T-025-13; REQ-CP-6).
--
-- A holder session proves control of one credential registered to the account
-- (T-020-06). Kippu keeps which one, so a holder's list of their registered
-- credentials can mark the credential this session was opened with. It is the
-- credential id the profile derives: public, never a key (REQ-SP-4). Null for
-- organiser and operator sessions, and for holder sessions opened before it was kept.

ALTER TABLE sessions ADD COLUMN holder_credential text;
ALTER TABLE sessions ADD CONSTRAINT sessions_holder_credential_check
  CHECK (holder_credential IS NULL OR principal_kind = 'holder');
