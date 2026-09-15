-- The derived copy's credential registrations, by account (T-025-09; REQ-CP-6,
-- NFR-11).
--
-- One row per credential the ledger has registered to an account, copied from
-- the registerCredential records in the log: the registration bytes exactly as
-- the ledger recorded them, and the account and credential id the cryptographic
-- profile derives from them. Re-registering a credential already registered is
-- accepted by the ledger and changes nothing, so it changes nothing here either.
-- Like the rest of the copy it is not authoritative (REQ-IX-1): the ledger's
-- getCredential is. Registrations hold public keys and attestation data, never
-- personal data (NFR-6).

CREATE TABLE derived_credentials (
  account text NOT NULL,
  credential text NOT NULL,
  registration bytea NOT NULL,
  -- The log sequence of the record that registered it.
  sequence bigint NOT NULL REFERENCES derived_log (sequence),
  PRIMARY KEY (account, credential)
);

-- The sponsor relay verifies authorisations against these registrations
-- before sponsoring (F-023 plan §5.3, T-023-09).
GRANT SELECT ON derived_credentials TO kippu_sponsor_relay_reader;
