#!/usr/bin/env bash
# Contract check for C5 (T-020-04): a client repository installs the packed
# @kippu/api tarball and compiles typed calls against it.
#
# Nothing is published. The tarball is installed from a temporary directory
# outside the workspace, the way a client repository would install it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pnpm --dir "$root" --filter @kippu/api build
pnpm --dir "$root/packages/api" pack --pack-destination "$work" >/dev/null
tarball="$(ls "$work"/kippu-api-*.tgz)"

echo "Packed $(basename "$tarball"):"
tar -tzf "$tarball" | sed 's/^/  /'

# Types only: no implementation may ship in the package.
if tar -tzf "$tarball" | grep -Ev '(\.d\.ts|/package\.json|/README\.md)$' | grep -q .; then
  echo "error: @kippu/api must contain declarations only" >&2
  exit 1
fi

cp -R "$root/fixtures/client" "$work/client"
cd "$work/client"
node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  manifest.dependencies["@kippu/api"] = `file:${process.argv[1]}`;
  fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2));
' "$tarball"

pnpm install --ignore-workspace --no-frozen-lockfile
pnpm run typecheck
echo "The client fixture compiles against the packed @kippu/api."
