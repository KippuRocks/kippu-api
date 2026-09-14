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
packages published for clients live beside it under `packages/`.

## Development

Requires Node 24 or later and pnpm (the version is pinned in `package.json`). CI gates on Node 24 (`AD-04`, `AD-21`).

```sh
pnpm install
pnpm lint        # Biome
pnpm typecheck
pnpm test        # Vitest
pnpm build       # emits dist/
pnpm start       # serves on $HOST:$PORT, default 0.0.0.0:8080
```

`GET /health` answers `{"status":"ok"}`. It is an operational endpoint, outside any versioned API prefix, and not part of the `C5` contract.

### Container image

```sh
docker build -t kippu-api .
docker run --rm -p 8080:8080 kippu-api
```

CI builds the image and probes its health endpoint on every pull request. The image is never pushed; the registry decision is pending.
