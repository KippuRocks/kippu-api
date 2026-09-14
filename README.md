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
