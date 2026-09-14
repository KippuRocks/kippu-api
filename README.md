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

## Development

Requires Node 24 or later and pnpm (the version is pinned in `package.json`). CI gates on Node 24 (`AD-04`, `AD-21`).

```sh
pnpm install
pnpm lint        # Biome
pnpm typecheck
pnpm test        # Vitest
pnpm build       # emits dist/
pnpm start       # serves on $HOST:$PORT, default 0.0.0.0:8080
pnpm lint:personal-data  # no metadata schema declares a personal-data field (after build)
pnpm check:contract  # a client fixture installs the packed packages and compiles against them
```

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
docker run --rm -p 8080:8080 kippu-api
```

CI builds the image and probes its health endpoint on every pull request. The image is never pushed; the registry decision is pending.
