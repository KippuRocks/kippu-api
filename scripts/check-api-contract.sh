#!/usr/bin/env bash
# Contract check for the packages clients install:
#   C5 (T-020-04) — a client repository installs the packed @kippurocks/api and
#                   compiles typed calls against it;
#   C6 (T-026-01) — the same client installs the packed @kippurocks/metadata-schema
#                   and reads the schemas from it.
#
# Nothing is published. Tarballs are installed from a temporary directory
# outside the workspace, the way a client repository would install them.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pack() {
  local package="$1" dir="$2"
  pnpm --dir "$root" --filter "$package" build >/dev/null
  pnpm --dir "$root/packages/$dir" pack --pack-destination "$work" >/dev/null
}

pack @kippurocks/api api
pack @kippurocks/metadata-schema metadata-schema
api_tarball="$(ls "$work"/kippurocks-api-*.tgz)"
schema_tarball="$(ls "$work"/kippurocks-metadata-schema-*.tgz)"

for tarball in "$api_tarball" "$schema_tarball"; do
  echo "Packed $(basename "$tarball"):"
  tar -tzf "$tarball" | sed 's/^/  /'
done

# @kippurocks/api is types only: no implementation may ship in it.
if tar -tzf "$api_tarball" | grep -Ev '(\.d\.ts|/package\.json|/README\.md)$' | grep -q .; then
  echo "error: @kippurocks/api must contain declarations only" >&2
  exit 1
fi

cp -R "$root/fixtures/client" "$work/client"
cd "$work/client"
node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  manifest.dependencies["@kippurocks/api"] = `file:${process.argv[1]}`;
  manifest.dependencies["@kippurocks/metadata-schema"] = `file:${process.argv[2]}`;
  fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2));
' "$api_tarball" "$schema_tarball"

pnpm install --ignore-workspace --no-frozen-lockfile
pnpm run typecheck
echo "The client fixture compiles against the packed @kippurocks/api and @kippurocks/metadata-schema."

node --input-type=module -e '
  import assert from "node:assert/strict";
  import { EVENT_SCHEMA_ID, CLASS_SCHEMA_ID, eventSchema, classSchema, lintPersonalData } from "@kippurocks/metadata-schema";
  import eventFile from "@kippurocks/metadata-schema/event/1.0.json" with { type: "json" };
  import classFile from "@kippurocks/metadata-schema/class/1.0.json" with { type: "json" };

  assert.equal(eventSchema.$id, EVENT_SCHEMA_ID);
  assert.equal(classSchema.$id, CLASS_SCHEMA_ID);
  assert.deepEqual(eventFile, eventSchema);
  assert.deepEqual(classFile, classSchema);
  assert.deepEqual(lintPersonalData(eventSchema), []);
  console.log("The client fixture reads the schemas from the packed @kippurocks/metadata-schema.");
'
