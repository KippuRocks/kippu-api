# Changesets

Versions of the packages under `packages/` are managed with
[Changesets](https://changesets.dev). Add a changeset with `pnpm changeset`
in any pull request that changes a published package; `pnpm changeset version`
applies them.

Nothing is published yet: the registry decision is pending. Until then,
`pnpm changeset pack` (or `pnpm pack` in a package) produces the tarballs that
the contract check installs.
