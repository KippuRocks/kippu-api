#!/usr/bin/env bash
# T-023-05: a client with no tRPC dependency obtains a sponsorship.
#
#   scripts/check-sponsor-client.sh <relay URL>
#
# Installs fixtures/sponsor-client outside the workspace, the way a client
# repository would — with only the V0 profile and the SDK, from the vendored
# libticketto tarballs — checks that nothing of tRPC or of kippu-api is
# installed, and runs it against a running relay.
set -euo pipefail

relay="${1:?usage: $0 <relay URL>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -R "$root/fixtures/sponsor-client" "$work/client"
cd "$work/client"
node -e '
  const fs = require("node:fs");
  const [vendor] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const profile = `file:${vendor}/ticketto-profile-v0-0.0.0.tgz`;
  const sdk = `file:${vendor}/ticketto-sdk-0.0.0.tgz`;
  manifest.dependencies["@ticketto/profile-v0"] = profile;
  manifest.dependencies["@ticketto/sdk"] = sdk;
  manifest.pnpm = { overrides: { "@ticketto/profile-v0": profile, "@ticketto/sdk": sdk } };
  fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2));
' "$root/vendor/libticketto"

pnpm install --ignore-workspace --no-frozen-lockfile >/dev/null
if [[ -e node_modules/@trpc || -e node_modules/.pnpm/node_modules/@trpc || -e node_modules/@kippu ]]; then
  echo "error: the sponsor client fixture must not install tRPC or any @kippu package" >&2
  exit 1
fi
node src/main.ts "$relay"
