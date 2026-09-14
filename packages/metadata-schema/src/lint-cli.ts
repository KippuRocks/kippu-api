/**
 * Runs the personal-data field lint over JSON Schema files and exits non-zero
 * if any declares a deny-listed field name.
 *
 * Usage: node dist/src/lint-cli.js <schema.json>...
 */
import { readFile } from "node:fs/promises";
import { lintPersonalData } from "./personal-data.js";

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("usage: lint-cli <schema.json>...");
  process.exit(2);
}

let failed = false;

for (const file of files) {
  const schema: unknown = JSON.parse(await readFile(file, "utf8"));
  const violations = lintPersonalData(schema);
  for (const { pointer, field } of violations) {
    console.error(`${file}#${pointer}: "${field}" names personal data`);
  }
  failed ||= violations.length > 0;
}

if (failed) {
  console.error("Metadata documents are public: no schema may declare a personal-data field.");
  process.exit(1);
}

console.log(`${files.length} schema(s) declare no personal-data field.`);
