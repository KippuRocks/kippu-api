# kippu-api

Kippu platform APIs: identity, events and organiser authority, primary sales and holds, sponsorship, operators, derived state, metadata. Features F-020–F-026.

This repository was reset for the V0 rebuild. The previous implementation is
preserved under the tag `legacy`.

Everything here is built from the Kippu specification and plan, in
`kippurocks/kippu-docs`: `SPEC.md` decides behaviour, `PLAN.md` and
`features/` decide how it is built. Work is tracked as one issue per feature
per milestone.

## Layout

The repository is a pnpm workspace. The server lives at the root (`src/`);
packages for clients live beside it under `packages/`:

| Package | What it is |
|---|---|
| `@kippu/api` (`packages/api`) | Types of the tRPC router — contract `C5`. Declarations only |
| `@kippu/metadata-schema` (`packages/metadata-schema`) | JSON Schemas for the public metadata documents — contract `C6` — and the personal-data field lint |
| `@kippu/sponsorship` (`packages/sponsorship`) | Sponsorship codec and verification, and the sponsor's `p256` KMS signer (`F-023`). Consumed by `ticketto-offchain` |

`@ticketto/sdk` and `@ticketto/profile-v0` are not published to a registry. They
are vendored as `pnpm pack` tarballs from a pinned `libticketto` commit
(`vendor/libticketto/`): `pnpm vendor:libticketto <commit>` re-pins them, and
`pnpm vendor:check` (run in CI) rebuilds them at the recorded commit and fails
if they differ.

## Development

Requires Node 24 or later and pnpm (the version is pinned in `package.json`). CI gates on Node 24 (`AD-04`, `AD-21`).

```sh
pnpm install
pnpm store:up    # the Kippu store: PostgreSQL 18 in Docker, on 127.0.0.1:54329
export KIPPU_DATABASE_URL=postgres://kippu_api:kippu_api_local@127.0.0.1:54329/kippu_api
export KIPPU_TEST_DATABASE_URL=$KIPPU_DATABASE_URL
export KIPPU_LOGIN_RP_ID=localhost                     # organiser login passkeys
export KIPPU_LOGIN_ORIGINS=http://localhost:5173        # Ibento's dev origin
export KIPPU_HOLDER_RP_ID=holder.kippu.example          # placeholder: holder credentials
export KIPPU_LEDGER_ENVIRONMENT=development             # backend-memory, software KMS, development sponsor
pnpm lint        # Biome
pnpm typecheck
pnpm test        # Vitest
pnpm build       # emits dist/
pnpm migrate     # applies pending migrations to the Kippu store (after build)
pnpm start       # serves on $HOST:$PORT, default 0.0.0.0:8080
pnpm lint:personal-data  # no metadata schema declares a personal-data field (after build)
pnpm check:contract  # a client fixture installs the packed packages and compiles against them
```

### The Kippu store

`kippu-api` keeps its own facts — identity, sessions, the audit log, holds, the
derived copy of the ledger — in PostgreSQL. It is a **separate instance, with
separate credentials**, from the ledger service's store (`AD-20`): `kippu-api`
reaches ledger state only through the Ticketto SDK (`REQ-SDK-9`), and no table
here is authoritative for a Ticketto fact (`REQ-IX-1`).

- `KIPPU_DATABASE_URL` is the only store configuration. The server refuses to
  start with libpq's `PG*` variables set, or with anything naming a ledger or
  Ticketto database.
- Migrations are plain SQL in `migrations/`, named `NNNN_snake_case.sql`,
  append-only, each applied in its own transaction. `pnpm migrate` applies
  them; the server refuses to start while any is pending, or when an applied
  one has changed.
- Locally, `compose.yaml` runs the store in Docker; CI uses a service
  container. A managed database is not chosen yet: in production it is
  supplied through `KIPPU_DATABASE_URL`, and nothing else changes.
- Store tests create a database of their own per file on
  `KIPPU_TEST_DATABASE_URL`. Without it they are skipped locally; in CI they
  may not be.

### The sponsor relay

Kippu sponsors every ledger write (`REQ-SP-1`, `AD-18` A) through a relay that runs as **its own process**: `pnpm sponsor:start` (`node dist/sponsor/server.js`, from the same image). It shares no code path with the API server, so neither one being down stops the other (`NFR-4`). A test checks that its module graph reaches nothing of the business layer.

- **Read-only access to the derived copy, plus organiser account ids, and nothing else.** Migration `0011` creates `kippu_sponsor_relay_reader`, a role that cannot log in and holds `SELECT` on the `derived_*` tables, including credential registrations (`0024`). It also holds `SELECT` on `sponsor_relay_organiser_accounts` (`0028`), a view of organisers' ledger account ids and nothing else of `organiser_ledger_accounts`. A deployment creates the relay's own login role and grants it that role. The relay connects with `KIPPU_SPONSOR_DERIVED_DATABASE_URL`, and its transactions are read only as well. It refuses to start with `KIPPU_DATABASE_URL`, libpq's `PG*` variables, or anything naming the ledger's store.
- **The sponsor key.** No KMS provider is chosen. Outside production, `KIPPU_SPONSOR_SOFTWARE_SECRET_KEY` (64 hex characters) is the key of the software stand-in behind `KmsP256Key`. `KIPPU_SPONSOR_ENVIRONMENT=production` refuses to start until a provider's adapter replaces it.
- **The client.** `createRelaySponsor` from `@kippu/sponsorship` is the SDK's `Sponsor` over this API, for kippu-api, Saifu and Iriguchi. A test drives kippu-api's SDK factory through it end to end (`test/sponsor/sponsor-client.test.ts`).
- **The API** is plain HTTP and JSON, documented in [`docs/sponsor-relay.md`](docs/sponsor-relay.md). `fixtures/sponsor-client` is a client with no tRPC dependency; CI installs it outside the workspace and obtains a sponsorship from the built relay (`scripts/check-sponsor-client.sh`).
- **Verified signers** (`T-023-09`). Before any entitlement is considered, an input's authorisation must verify with the V0 profile against a credential registration of its account in the derived copy. An account's first registration is instead verified against the registration it carries. A forged or unregistered authorisation is refused, and never counts against another account's registration limit. `KIPPU_SPONSOR_HOLDER_RP_ID` (required) is the holder credentials' RP id the profile verifies with.
- **Entitlements** (`src/sponsor/entitlements.ts`, `F-023` §5.3). `POST /v0/sponsor` takes a signed command or pass, framed `{ "input": { "kind", "bytes" } }` as `C4` frames it. It returns a sponsorship only when an entitlement covers the input:
  - an organiser command signed by the event's owner;
  - `createEvent` by a Kippu organiser account, whose event id derives from it;
  - `issueTicket` signed by the owner;
  - `transferTicket` signed by the ticket's holder, when the ticket is transferable;
  - `registerCredential`, within a rate limit per account;
  - an access pass whose ticket exists and whose event is neither `Cancelled` nor `Finished`.

  Anything else is `403 ERR-SponsorshipRefused`. The plan sets no numbers for the registration rate limit, so both `KIPPU_SPONSOR_REGISTRATIONS_PER_WINDOW` and `KIPPU_SPONSOR_REGISTRATION_WINDOW_SECONDS` are required.
- **Lag.** The derived copy trails the ledger (`NFR-11`), so it can wrongly refuse an entitled input, but never wrongly grant one. A request may add `"after": "<cursor>"`, the receipt cursor of the write that gave rise to the entitlement, such as the issuance or transfer of the ticket. If the relay refuses, it waits up to `KIPPU_SPONSOR_LAG_WAIT_MS` (required, no default) for the copy to reach that cursor, then decides again.
  - If the copy still has not reached the cursor, the answer is `503 lagging` with `Retry-After`, never a refusal (`REQ-SP-5`).
  - A refusal from a copy that already reflects the cursor is final.
- **Where it listens.** `KIPPU_SPONSOR_HOST` and `KIPPU_SPONSOR_PORT` set the address, by default `0.0.0.0:8082`. `GET /health` answers only while the derived copy can be read, and reports the sponsor account and how far the copy has read the log.

```sh
psql "$KIPPU_DATABASE_URL" -c "CREATE ROLE kippu_sponsor_relay LOGIN PASSWORD 'local' IN ROLE kippu_sponsor_relay_reader"
KIPPU_SPONSOR_ENVIRONMENT=development \
KIPPU_SPONSOR_DERIVED_DATABASE_URL=postgres://kippu_sponsor_relay:local@127.0.0.1:54329/kippu_api \
KIPPU_SPONSOR_SOFTWARE_SECRET_KEY=$(openssl rand -hex 32) \
KIPPU_SPONSOR_REGISTRATIONS_PER_WINDOW=5 KIPPU_SPONSOR_REGISTRATION_WINDOW_SECONDS=3600 \
KIPPU_SPONSOR_LAG_WAIT_MS=5000 KIPPU_SPONSOR_HOLDER_RP_ID=holder.kippu.example \
KIPPU_DATABASE_URL= pnpm sponsor:start
```

### Metadata storage and serving

Event and class documents, the schemas they declare, and the images they reference are public objects (`F-026` §5.3, `REQ-MD-4`). They are addressed at `https://meta.kippu.rocks` (`AD-22`): the `KIPPU_METADATA_PUBLIC_URL` setting, which defaults to it. A URL's path under that origin is the object's key, so `https://meta.kippu.rocks/v0/schemas/event/1.0.json` is stored at `v0/schemas/event/1.0.json`.

**Nothing real exists yet.** No object store, CDN, DNS record or bucket has been created. The pieces below are local stand-ins, each behind a seam a real provider plugs into:

- **Object storage.** `src/metadata/storage.ts` speaks S3 to any S3-compatible store. Locally and in CI that store is MinIO. A provider is configured through the same `KIPPU_METADATA_S3_*` keys. Every object is stored with its `Content-Type` and `Cache-Control`.
- **CDN.** `src/metadata/edge.ts` (`pnpm metadata:edge`) stands in for the CDN. It serves objects with no authentication and open CORS (`Access-Control-Allow-Origin: *`, never credentials). It sends `Cache-Control: public, max-age=60`, so an edit is visible within a minute, plus `ETag` revalidation, and refuses writes. A real CDN in front of the bucket must be configured to behave the same way. The bucket itself stays private.
- **Schemas.** `pnpm metadata:publish-schemas` stores every schema file of `@kippu/metadata-schema`, byte for byte, at the key its `$id` names.

```sh
pnpm store:up    # also starts MinIO on 127.0.0.1:59000, with the kippu-metadata bucket
export KIPPU_TEST_S3_ENDPOINT=http://127.0.0.1:59000
export KIPPU_TEST_S3_ACCESS_KEY_ID=kippu_metadata KIPPU_TEST_S3_SECRET_ACCESS_KEY=kippu_metadata_local
export KIPPU_METADATA_S3_BUCKET=kippu-metadata KIPPU_METADATA_S3_ENDPOINT=$KIPPU_TEST_S3_ENDPOINT
export KIPPU_METADATA_S3_FORCE_PATH_STYLE=true
export KIPPU_METADATA_S3_ACCESS_KEY_ID=$KIPPU_TEST_S3_ACCESS_KEY_ID
export KIPPU_METADATA_S3_SECRET_ACCESS_KEY=$KIPPU_TEST_S3_SECRET_ACCESS_KEY
pnpm build && pnpm metadata:publish-schemas
pnpm metadata:edge   # serves on $KIPPU_METADATA_EDGE_HOST:$KIPPU_METADATA_EDGE_PORT, default 0.0.0.0:8081
curl -i -H "Origin: https://any.example" http://127.0.0.1:8081/v0/schemas/event/1.0.json
```

Object storage tests create a bucket of their own per file on `KIPPU_TEST_S3_ENDPOINT`. Without it they are skipped locally; in CI they may not be. CI also publishes the schemas from the built output and fetches one cross-origin through the built edge.

### Organiser and operator sessions

- **Organisers** sign up with an email and one passkey, then sign in with that passkey.
  - The email is an identifier only and is not verified in V0.
  - Each step is an explicit WebAuthn exchange in `auth.organiser`: `begin*` returns a challenge, and `complete*` takes the credential and returns a session.
  - Passkeys are bound to `KIPPU_LOGIN_RP_ID` and must be user-verified.
  - The server refuses to start when `KIPPU_LOGIN_RP_ID` equals `KIPPU_HOLDER_RP_ID`, the holder credential's RP id. A login passkey therefore never shares a picker with a holder credential, and can never authorise a ledger operation.
- **Operators** redeem a one-time enrolment code for a session with `auth.operator.redeemEnrolmentCode`. Their organiser issues the code (`F-024`). The ledger never learns who an operator is (`REQ-OP-1`).
- **Sessions** are opaque random bearer tokens.
  - Only a SHA-256 of each token is stored.
  - Tokens are sent as `Authorization: Bearer <token>`.
  - They last 12 hours for organisers and 24 hours for operators, and end earlier on `auth.session.signOut` or revocation.
  - Procedures that need a principal use `organiserProcedure`, `operatorProcedure` or `authenticatedProcedure` (`src/trpc/trpc.ts`).
- **Holders** link by proving control of a ledger account (`REQ-SP-4`).
  - `auth.holder.beginLink({ account })` returns a proof-of-control challenge: audience `kippu-api@<login RP id>`, a 32-byte nonce, a 5-minute expiry, and the account.
  - Saifu signs the challenge with the holder credential (`@ticketto/profile-v0`'s `signProofOfControl`). `auth.holder.completeLink` then reads the credential's registration from the ledger with `getCredential` through the SDK factory — never from the client — verifies with `verifyProofOfControl`, and opens a 30-day holder session.
  - Only `pass-webauthn` credentials link. Each nonce is consumed once. Every refusal is the same `UNAUTHORIZED`, whichever check failed.
  - `createAuth` takes the SDK as `holders.credentials`. The server does not pass it yet: the SDK needs `F-023`'s sponsor client before the server can construct it, and until then linking refuses.
- **The anonymous principal** is who a call with no live session acts as. Browsing needs no account, keys or wallet (`REQ-MP-7`).
  - It reaches only procedures built on `publicProcedure`. Every other procedure refuses it with `UNAUTHORIZED`, including one whose access is left undeclared.
  - `test/trpc/anonymous.test.ts` lists the public procedures, walks the root router, and fails if any other procedure lets the anonymous principal in.

The hostnames are not chosen yet: every RP id and origin in this repository is a placeholder.

### The audit log (`NFR-7`)

Every ledger write Kippu relays goes through `relay` (`src/audit/relay.ts`).
Writes Kippu never sees, sent directly by Saifu and Iriguchi, are covered by the derived copy (`NFR-11`) instead.

- `relay` hands the SDK call an **audited signer**. Before signing, the signer reads the command back out of its signing payload and writes an `audit_log` row: request id, principal (with its session), operation id and command kind.
- The signer refuses to sign bytes that are not a command, and refuses any command whose row cannot be written. A signature over a relayed write therefore exists only with a prior audit row.
- The submission returned to the caller settles or is rejected only after the row records the outcome: `settled` with the receipt's cursor, `rejected` with the §10 code, or `failed`.
- Integration tests of relaying features assert coverage with `expectEveryRelayedWriteAudited` (`test/support/ledger.ts`).

### The SDK factory (`NFR-6`)

`makeTicketto({ environment, holderRpId, sponsor, operationLifetime })`
(`src/ledger/ticketto.ts`) is the only place kippu-api constructs the Ticketto SDK.

- **Backend.** In `development` and `test` the backend is `backend-memory`. In `production` the factory refuses until `binding-offchain` implements the backend port; its configuration will be the ledger service's endpoint, never credentials for its store (`REQ-SDK-9`).
- **Profile.** The profile is `profile-v0` with the holder RP id.
- **Callers supply the rest.** The sponsor is `F-023`'s client, and the signer is resolved per request (`F-021`). `AD-15` sets no default operation lifetime, so the caller passes one.
- **The `NFR-6` allow-list** (`src/ledger/allow-list.ts`) names every field a command input may carry, down to nested objects.
  - A field outside it fails type-checking, even when it arrives in a variable.
  - It is also refused at runtime, before anything is signed.
  - A field added to the SDK surface fails type-checking in the allow-list until someone reviews and lists it.
- **Errors.** `unwrap(result)` turns an SDK result's §10 code into the tRPC error clients read. Any internal error reaches the client as `internal error`, with no message and no stack; the server logs it.

`@ticketto/sdk`, `profile-v0`, `ledger-rules` and `backend-memory` are vendored from the libticketto commit in `vendor/libticketto/source.json` (`pnpm vendor:libticketto <commit>`).

### The development wiring (`T-021-11`)

`pnpm start` serves the domain services — organiser and operator sessions, holder linking, and events, zones, classes and granted issuance — over the ledger `KIPPU_LEDGER_ENVIRONMENT` names. It is required, with no default. `createServer` (`src/wiring.ts`) is the composition `src/server.ts` runs, and the one its test drives.

- **`development`** (and `test`) run everything in the server's own process:
  - the SDK over `backend-memory`;
  - a software KMS for organiser keys;
  - a sponsor. When `KIPPU_SPONSOR_URL` names the sponsor relay (`pnpm sponsor:start`, reading this same Kippu store's derived copy), every write is sponsored through `createRelaySponsor`, with the relay's entitlements. Each request carries the receipt cursor of the server's latest settled write (`src/ledger/receipts.ts`), so an event's first ticket, issued right after the event is created, waits for the relay's copy instead of being refused (`REQ-SP-5`). Without `KIPPU_SPONSOR_URL`, the development sponsor (`src/ledger/development-sponsor.ts`) signs a real sponsorship for every input at nil notional cost, with a software key, and evaluates no entitlement; `backend-memory` verifies none.
  - **Ledger state and organiser keys live only in memory.** A restart forgets every event and ticket, while the Kippu store keeps its rows; start from a fresh store after a restart.
- **The derived copy** (`F-025`): the server starts its reader over the ledger's log, and serves the `derived` read routes with their freshness.
- **Metadata** (`F-026`): event locators name `KIPPU_METADATA_PUBLIC_URL`. When `KIPPU_METADATA_S3_BUCKET` is set, with the rest of the `KIPPU_METADATA_*` keys, document editing is mounted over that storage and reads join the documents. Without it, editing fails, reads join no documents, and everything else is served.
- **`staging`** (`T-023-08`) runs the SDK over `binding-offchain` against a `ticketto-offchain` ledger service.
  - `KIPPU_LEDGER_SERVICE_URL` is the service's endpoint: an http(s) URL, read only in staging. kippu-api holds no credential for the service's store, and refuses any it is given (`REQ-SDK-9`).
  - `KIPPU_SPONSOR_URL` names the sponsor relay. Both are required.
  - The server connects to the service before it starts, reading its assurance declaration.
  - Organiser keys are still in the software KMS, since no provider is chosen. They are lost when the server exits, while the ledger service keeps everything they signed.
  - The service is private and unpublished, so the end-to-end check in `test/server/staging-wiring.test.ts` runs only when `KIPPU_TEST_LEDGER_SERVICE_URL` and `KIPPU_TEST_SPONSOR_SECRET_KEY` are set: locally, and in `kippu-e2e` (`F-070`). It creates an event through tRPC and finds it in the service's log. Start the service with `TICKETTO_ENVIRONMENT=staging` and that key's sponsor account in `TICKETTO_SPONSOR_ACCOUNTS`.
- **`production`** is refused at start-up until a KMS provider for organiser keys is chosen.
- `test/server/development-wiring.test.ts` runs the server from its configuration, and drives the whole flow through tRPC: an organiser signs up and signs in, creates an event, uploads seat positions and defines a class; a guest links their holder account; the organiser issues them a granted ticket, edits the event's document, and reads the event back from the derived copy.

### Organiser authority (`REQ-OA-1`)

Kippu holds and exercises each organiser's authority over their events on the ledger; organisers never handle ledger credentials (`US-A2`). `createOrganiserAuthority` (`src/authority/authority.ts`) is the only way to sign with it.

- **One `p256` key per organiser**, held in a KMS behind `OrganiserKms` (`src/authority/kms.ts`). A key is reached through `@kippu/sponsorship`'s `KmsP256Key`, as the sponsor's is. The organiser's ledger account is the key's `p256` account.
- **No KMS provider is chosen.** In `development` and `test`, `softwareOrganiserKms` stands in: keys in process memory, lost on exit, like `backend-memory`'s ledger. In `production`, `organiserKmsFor` refuses until a provider's adapter implements `OrganiserKms`.
- **The Kippu store holds no key material.** `organiser_ledger_accounts` keeps the key's reference in the KMS, its public key, its account and its self-registration, with the request that caused the key to be created.
- **Provisioning is lazy.** An organiser's first write creates their key, signs its self-registration once that row exists, and relays `registerCredential` (`REQ-CP-6`) before anything else is signed.
- **Audit before signing (`NFR-7`).** `authority.relay` goes through `relay`, so the audit row is written first. The organiser's signer then refuses to reach the KMS unless the command already has a pending audit row. A signature by an organiser's key therefore exists only with a prior audit row.

`@kippu/sponsorship` is a workspace dependency of the server, so `pnpm build`, `pnpm typecheck` and `pnpm test` build it first (`pnpm build:deps`).

### Events, classes and granted issuance (`F-021`)

The `events` router is the organiser's. Every procedure acts for the signed-in organiser, and Kippu signs any ledger write with their authority. An event's owner is read from the ledger (`REQ-IX-1`): `ERR-EventNotFound` when the ledger has no such event, `ERR-NotOwner` when the organiser does not own it.

- **Events** (`events.create`) are created with the organiser's authority, so the ledger records their account as the owner, `Active` (`AC-A1.1`). The SDK derives the `EventId` through the profile from that account and a random salt (`REQ-EV-9`). The procedure answers once the ledger has recorded the event, with its id and the receipt's cursor. `organiser_events` links the event to the organiser and the request that created it; ledger facts about the event live in the derived copy, not here.
- **Seal, cancel and finish** (`events.seal`, `events.cancel`, `events.finish`; `US-A4`, `US-A5`, `REQ-EV-11`). The ledger decides which transitions are permitted. An event still `Active` has its sales released first through `F-022` (`releaseAll`: sales close, holds are released, open hosted checkouts cancelled; `REQ-HD-4`), and they reopen if the ledger refuses. Once an event is `Cancelled`, one refund entitlement is recorded per purchased ticket (`AC-A5.5`); cancelling a cancelled event records any still missing.
- **Scheduled `Finished`** (`events.scheduleFinish`, `events.cancelScheduledFinish`, `events.finishSchedule`; `REQ-EV-12`). Off unless the organiser sets a time; a notice falls due 24 hours before (`noticedAt`: V0 has no mail sender, so the notice is recorded for Ibento to show); cancellable until it runs. The server's finish scheduler runs due notices and finishes every 30 seconds. **The system principal**: a write with no user behind it is audited with `principal_kind` `system`, attributed to the organiser who scheduled it (`organiser_id`), with request id `scheduled-finish:<schedule id>` (`NFR-7`). A ledger refusal when it runs is recorded on the schedule.
- **Capacity decrease** (`events.decreaseCapacity`, `US-A6`). Under the event's allocation lock, Kippu refuses a capacity below the tickets issued plus outstanding holds with `ERR-CapacityBelowIssuance` (`REQ-HD-4`; `F-022`'s `canDecreaseCapacity`), with `error.data.reason` `held` when the ledger's issued count alone would allow it, then submits `setEventCapacity`. An increase is refused with `ERR-CapacityProofRequired` before it reaches the ledger: it needs an approved capacity proof.
- **Pass window** (`events.passWindow`, `events.setPassWindow`): how long an access pass for the event stays valid (`NFR-5`, `REQ-AP-3`), in milliseconds, in `event_pass_windows`. The organiser sets it between 10 seconds and the ledger's maximum pass window; it is 60 seconds (the profile's `DEFAULT_PASS_WINDOW`) until they do. The maximum comes from the rules configuration the server runs the ledger with (`src/ledger/rules.ts`, `T-008-17`). The ledger enforces only its maximum, so the window is a Kippu setting, not a ledger fact. Organiser reads only; Saifu's and Iriguchi's are `T-025-11`.
- **Zones** (`events.zones.add`, `events.zones.remove`) are ledger writes. The ledger's verdict — `ERR-ZoneExists`, `ERR-ZoneInUse`, `ERR-EventSealed` — is passed on unchanged (`REQ-ID-7`).
- **Seat positions** (`events.zones.addSeatPositions`, `events.zones.seatPositions`) are each seated zone's canonical positions, uploaded by the organiser into `seat_positions` (`F-021` plan §5.3). Issuance accepts only a position on the list, matched exactly, and refuses anything else before it signs or submits (`REQ-ID-3`): `C-14` on the list does not admit `c14`. Designations are normalised to Unicode NFC before they are stored or derived from, so visually identical spellings are one seat; case and punctuation are kept. A position reaches the ledger as the UTF-8 bytes of the NFC designation (`positionOf`). Removing a zone removes its positions.
- **Classes** (`events.classes.define`, `events.classes.list`) are Kippu data (`REQ-TC-2`), stored in `ticket_classes`: name, description, provenance, attendance policy, restrictions, quota and an opaque random 32-byte id.
  - A class declared `Purchased` with a restriction is refused at definition with `ERR-RestrictionNotPermitted` (`REQ-TC-3`). The store refuses it too.
  - `cannotTransfer` implies `cannotResale` (`REQ-TK-2`), so the class records the restrictions its tickets will carry on the ledger.
- **Sale assets and prices** (`F-021` plan, "Prices"). Each event's sale asset — `COPM/2` or `DUSD/6` — is the organiser's, set at creation (`saleAsset`) or later (`events.setSaleAsset`), in `event_sale_assets`. It is fixed once the event has had a hold, in any status, since a sale needs one; the change is made under the event's allocation lock (`src/sales/allocation.ts`), so no hold slips in between. Every `Purchased` class has a price, a positive integer in the asset's minor units, required at definition and changed with `events.classes.setPrice`; `Granted` classes have none. Prices are in the asset's minor units, so changing the asset from one to another clears every `Purchased` class's price, in the same transaction; choosing the first asset, or setting the one in force, clears nothing. A hold records the asset and price in force when it is placed, so a price change affects only later holds. Nothing is held, and `sales.inventory` is not on sale, before an asset is chosen or while any `Purchased` class is unpriced. `sales.inventory` shows both. Neither reaches the ledger (`AC-B4.2`).
- **Granted issuance** (`events.tickets.issueGranted`) issues a ticket from a `Granted` class to a holder's account (`US-B2`).
  - The ticket carries the class's id, policy and restrictions, and `Granted` provenance (`REQ-TK-4`). A seat must be a canonical position of its zone; an unseated ticket gets a random 128-bit discriminator.
  - Kippu refuses a class not defined for the event with `ERR-UnknownClass`, and one whose quota is reached with `ERR-ClassQuotaExceeded` (platform errors, `SPEC.md` §10 note). A `Purchased` class is refused: its tickets are sold through checkout.
  - The quota counts `granted_issuances` rows under a lock on the class, so concurrent issuances never exceed it. A ledger refusal frees its place; a submission with no verdict keeps it, since the ticket may exist.
  - Every other refusal is the ledger's, passed on: `ERR-CapacityExceeded`, `ERR-TicketIdExists`, `ERR-ZoneKindMismatch`, and so on.
  - Free means free at every layer (`REQ-TC-4`): the issuance writes its audit row and its issuance record, and no payment record of any kind.
- **Seated double allocation** (`AC-B5.2`) is refused before anything is signed, with `ERR-TicketIdExists`: when the ledger holds a ticket for the seat, whoever issued it, or when a granted issuance of it is in flight or settled. `SeatAllocation` (`src/events/seats.ts`) is the check as a service function: lock the seat, then assert it free, inside the transaction that records the allocation, so every way of allocating a seat — holds included — checks the same thing. The ledger's own `ERR-TicketIdExists` stays the guarantee (`REQ-ID-2`).
- **Holds count** (`REQ-HD-3`, `REQ-HD-4`). Granted issuance, and so invitation redemption, counts checkouts' outstanding holds with `F-022`'s accounting (`src/sales/allocation.ts`), under the same locks in the same order as a hold: the seat, then the event's allocations. A seat a buyer holds is refused (`CONFLICT`, no §10 code); a place or class quota taken by issued tickets and holds is refused with `ERR-CapacityExceeded` or `ERR-ClassQuotaExceeded`, before submission.
- **Invitations** (`events.invitations.create`, `.list`, `.redeem`) reach a guest who has no holder account yet (`F-021` plan §5.6).
  - The organiser creates an invitation to a granted class at a placement, checked as issuance checks it, with an optional guest note that stays in Kippu (`NFR-6`). Its token — 32 random bytes, base64url — is returned once; `invitations` keeps only its SHA-256.
  - Saifu links the guest's holder account (`auth.holder.*`) and redeems the token in that holder session. Redemption claims the invitation atomically and runs granted issuance for the invitation's organiser, audited against the holder's session: the ticket is issued once.
  - An unknown token is `NOT_FOUND`; a redeemed one `CONFLICT`. Every refusal also carries an `InvitationRefusal` in `error.data.reason` — `unknown-invitation`, `already-redeemed`, `seat-held`, `seat-taken`, `sold-out`, `class-sold-out` — so Saifu can tell the holder which applies. A reason is a platform refusal, never a §10 code. A refused issuance — quota, capacity, a ledger rule — reopens the invitation; one with no ledger verdict leaves it `failed`, since the ticket may exist.

### Operator authorisation (`F-024`)

Gate staff are managed like staff, not like key holders (`US-E5`). Operators, their enrolment and their sessions live entirely in Kippu: the ledger never learns who an operator is (`REQ-OP-1`), and nothing in the `operators` router writes to it.

- **Operator accounts** (`T-024-01`): an organiser creates named operators (`operators.create`) and lists them with their live session count (`operators.list`). The name is the organiser's own label and stays in Kippu (`NFR-6`).
- **Enrolment** (`operators.issueEnrolmentCode`): a one-time code — 16 random bytes, base64url — returned once, stored as a SHA-256, valid for an hour. Iriguchi redeems it with `auth.operator.redeemEnrolmentCode` for a 24-hour operator session. Codes issued earlier stay valid until they expire or are redeemed.
- **Revoking sessions** (`operators.revokeSessions`) ends every live session of the operator at once and voids their unredeemed codes; the operator enrols again only with a code issued afterwards. Revoking a session is separate from revoking a grant; either stops admissions.
- **Grants** (`T-024-02`; `F-024` plan §5.1): `operators.grants.create({ operator, event, gates, from, until })` lets an operator operate the named gates of an event from `from` until strictly before `until` (Unix milliseconds). Gates are the organiser's own labels, matched exactly. The organiser must own the event, read from the ledger (`ERR-EventNotFound`, `ERR-NotOwner`); grants and revocations write nothing to it (`AC-E5.1`). `operators.grants.list` filters by event and operator; `operators.grants.revoke` takes effect on the operator's next check. An operator reads their live and upcoming grants with `operators.grants.mine`.
- **The check** (`T-024-03`; `AC-E5.2`): `operators.check({ event, gate })`, in an operator session, is what Iriguchi runs alongside `canAttend`, not in its path. It answers the authorising grant, when it ends, and Kippu's clock (`checkedAt`); otherwise `FORBIDDEN` with `error.data.reason` `grant-revoked`, `before-window`, `after-window` or `not-granted`. A revoked or ended session is `UNAUTHORIZED`. It is one indexed read per call and nothing caches it, so a revocation of either kind refuses the next check. `test/operators/check.test.ts` holds it under 100 ms at the 95th percentile over HTTP against the test store (`NFR-1` leaves the gate 300 ms in all).
- **Admission reports** (`T-024-04`; `REQ-OP-3`, plan §5.3): after each verdict, Iriguchi sends `operators.reportAdmission` — event, gate, ticket, pass id, the verdict and, for an admission, how its direct submission ended (settled with the receipt's cursor, rejected with the ledger's §10 code, or failed), with the `presentedAt` it submitted and its own device clock. Kippu stamps `receivedAt` with its clock, so drift can be flagged. The report id is Iriguchi's UUID, so a retry is recorded once. A report needs a grant for that gate of the event (`not-granted`): an ended grant still counts, and a revoked one only for a pass presented before its revocation (`grant-revoked`). An operator session revoked within the last 24 hours, by its organiser or by signing out, may still send `operators.reportAdmission` — and nothing else — for a pass presented before the revocation; anything else from it is `UNAUTHORIZED` (plan §5.4). Reports are stored in `admission_reports`; `F-025` reads them with `createAdmissionReports(...).list({ event, passId, after, limit })` (`src/operators/reports.ts`), which the server's wiring returns as `admissionReports`. A report is evidence for the organiser, never a ledger fact.
- An operator of another organiser is `NOT_FOUND`, with `error.data.reason` `unknown-operator`; a grant, `unknown-grant`; another operator's report id, `CONFLICT` with `report-exists`.

### Checkout, handoff pairing and holds (`F-022`)

- **Checkout** (`sales.checkout.*`): `begin` for what the buyer picked returns the page's `token`, once. With a holder session the checkout is linked at once; otherwise it carries a Saifu handoff with a separate `handoffToken`, which only links.
- **Pairing** (plan §5.1, ruled in `M2`): Saifu links with the handoff token and gets a 6-digit pairing code; the checkout page shows the same code, and the buyer confirms the match (`confirmLink`) or discards the link (`discardLink`, which replaces the handoff token). An unconfirmed link cannot hold.
- **Inventory** (`sales.inventory`, public): availability of the event and each `Purchased` class counting outstanding holds, and each seated zone's free seats — for display; the hold decides.
- **Paying** (plan §5.1 steps 4–7, `src/sales/payment.ts`): `sales.checkout.pay` creates the provider's single-use hosted checkout for an outstanding hold, at the hold's recorded price and asset, expiring with the hold (its single 5-minute extension is taken then). The provider's webhook arrives at `POST /webhooks/payments`, is verified by signature, and only prompts a retrieval; a checkout retrieved `paid` for the hold's amount and asset issues the ticket through the organiser's authority and confirms the hold. Not paid — abandoned (`sales.checkout.cancel`) or lapsed (the background sweep cancels its hosted checkout) — no ticket and no charge. Paid but not issued: a refund entitlement. Every issued purchased ticket gets a face-value row (`face_values`) — the price its hold recorded — for its life (`T-022-06`). `KIPPU_PUBLIC_URL` is the origin webhooks are sent to (required with Bloque; `http://localhost:8080` in development).
- **Lifetime**: a checkout with no hold expires an hour after it began. A hold lives 10 minutes, extendable once by 5 (`src/sales/holds.ts`), counted with `src/sales/allocation.ts`.

### Payments (`F-022`)

Checkout takes payment through a provider's **hosted checkout** (`F-022` plan §5.4): Kippu creates a checkout for a hold, expiring with it; the buyer is redirected to the provider's page and pays there by card or PSE (never cash); the provider's HMAC-signed webhook is trusted only once the checkout, retrieved, is paid for the expected amount and hold. Kippu passes no payer details and sees no payment details. There is no authorise/capture split and no refund call: refunds are entitlements (plan §5.5).

- `src/sales/payments/ports.ts` is the adapter: `createCheckout`, `retrieve`, `cancel`, `verifyWebhook`.
- `src/sales/payments/test-provider.ts` is the deterministic, scriptable test provider (paying, expiry, failures, a payment racing a cancel, signed and forged webhooks). Development and tests use it.
- `src/sales/payments/bloque.ts` is the Bloque adapter over `@bloque/payments`. It is tested against a mocked client only. **No Bloque account or key exists for this repository yet**; credentials are environment configuration, supplied for a deployment, and are unset in CI:

| Variable | What it is |
|---|---|
| `KIPPU_BLOQUE_PAYMENTS_MODE` | `sandbox` or `production` |
| `KIPPU_BLOQUE_PAYMENTS_SECRET_KEY` | Bloque's secret key: `sk_test_…` in sandbox, `sk_live_…` in production |
| `KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET` | The secret Bloque signs webhooks with |

All three or none. With none, the test provider is used in `development` and `test`; `staging` and `production` refuse to take payments without Bloque. Setting `KIPPU_TEST_BLOQUE_PAYMENTS_SECRET_KEY` and `KIPPU_TEST_BLOQUE_PAYMENTS_WEBHOOK_SECRET` (sandbox) runs the adapter's sandbox test, which creates, retrieves and cancels one checkout; it is skipped otherwise.

- **Organiser actions** (`T-022-05`, `REQ-HD-4`; `src/sales/organiser-actions.ts`, reached as `createSales(...).organiserActions`): `canDecreaseCapacity(event, to, db?)` — issued tickets plus holds not yet issued at most `to`; pass a transaction holding `lockEventAllocations` to keep it true until the write. `releaseAll(event, cause)` before a seal or cancellation closes the event's sales in Kippu (no checkout, hold or payment; inventory not on sale), releases every outstanding hold, cancels open hosted checkouts, and records an `event-closed` refund entitlement for any payment already taken. `reopenSales(event, cause)` if the organiser's write is refused. `recordCancellationRefunds(event, cause)` once the event is `Cancelled` (`T-022-07`, `AC-A5.5`): one `event-cancelled` refund entitlement per purchased ticket, at most once, for its face value, owed to its original purchaser, with the holder at cancellation (`getCancellationHolder`, `REQ-EV-10`) recorded.
- **Confirmation freshness** (plan §5.1, ruled in `M2`): `sales.checkout.get` reports `ticketVisible` — true once Kippu's copy has passed the sale's issuance receipt (`NFR-11`) — read with the checkout page's token; `waitForTicketMs` (up to 10 s) waits for it once the sale is issued. Ichiba says the ticket is in Saifu only then. No public `waitFor` is exposed.
- **Audit** (`T-022-09`; `REQ-MP-8`, `NFR-7`): every step of a checkout — begun, linked, link confirmed or discarded, held or refused, payment started, cancelled, payment verified, issued, issuance rejected or failed, refund entitled — is a `checkout_audit` row naming the request and who made it (the buyer's page, a holder session, the payment provider, the sweep). A sale's issuance is joined to its `audit_log` row by operation id; `primary_checkout_audit` is exactly the audit log's primary-checkout issuances. `primarySaleTrail` (`src/sales/audit.ts`) reads a sale end to end.

#### Driving the test payment provider over HTTP

End-to-end suites that run kippu-api as a separate process (Ichiba's, `T-060-05`) script the deterministic test provider through a **test-only** route:

```http
POST /v0/testing/payments/:checkoutId
Content-Type: application/json

{ "outcome": "paid" | "cancelled" | "expired", "amount"?: 1234, "webhook"?: true }
```

- `:checkoutId` is the provider's checkout id: the last path segment of `Checkout.payment.url`.
- `paid` marks the checkout paid (for `amount` when given, to test a mismatch); `cancelled` is a failed payment attempt, which ends a single-use checkout; `expired` expires it.
- Unless `webhook` is `false`, the provider's signed webhook is then delivered to Kippu's webhook handling, exactly as `POST /webhooks/payments` receives it. The answer is `{ checkout: { id, status, amount, asset }, webhook: "delivered" | "skipped" }`; an unknown checkout is 404, one no longer open 409.
- **Mounted only** when `KIPPU_LEDGER_ENVIRONMENT` is `development` or `test` **and** no Bloque credentials are set, so the test provider is in use. With Bloque's credentials, in `staging` or in `production`, the path does not exist (404).

### Package releases

Package versions are managed with Changesets (`pnpm changeset`). Nothing is
published yet — the registry decision is pending. `pnpm check:contract` packs
`@kippu/api` and `@kippu/metadata-schema` and installs the tarballs into
`fixtures/client` outside the workspace, the way a client repository would.

`GET /health` answers `{"status":"ok"}`. It is an operational endpoint, outside any versioned API prefix, and not part of the `C5` contract.

## The tRPC contract (`C5`)

The root router (`src/trpc/router.ts`) is served under `/v0/trpc`. Domain
routers (`F-021`–`F-026`) are composed into it, one per feature.

A procedure that fails with a `SPEC.md` §10 error throws `toTRPCError({ code })`
(`src/trpc/errors.ts`). The response carries the §10 code verbatim in
`error.data.errorCode` — for example `ERR-EventNotFound` — so a client shows
the spec's reason without a translation table of its own (`REQ-Q-3`). A code
that is not a §10 code is never passed on; the client sees an internal error.

### Container image

```sh
docker build -t kippu-api .
docker run --rm --network host -e KIPPU_DATABASE_URL kippu-api node dist/store/migrate-cli.js
docker run --rm --network host -e KIPPU_DATABASE_URL kippu-api
```

CI builds the image and probes its health endpoint on every pull request. The image is never pushed; the registry decision is pending.
