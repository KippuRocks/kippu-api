/**
 * `pnpm metadata:check-self-contained` — checks that every stored event and class
 * document references only URLs served from the metadata public origin, so the
 * documents can be relocated by moving files (`REQ-MD-1`, `F-026` plan §5.3).
 * Exits non-zero, listing each offending document, when any is not.
 */
import { loadMetadataConfig } from "./config.js";
import { checkStoredDocuments } from "./self-contained.js";
import { createS3MetadataStorage } from "./storage.js";

const config = loadMetadataConfig();
const violations = await checkStoredDocuments(
  createS3MetadataStorage(config.storage),
  config.publicUrl,
);
for (const { key, references, unreadable } of violations) {
  if (unreadable !== undefined) {
    console.error(`${key}: not a JSON document (${unreadable})`);
  }
  for (const { pointer, url } of references) {
    console.error(`${key}: ${pointer} references ${url}, not served from ${config.publicUrl}`);
  }
}
if (violations.length > 0) {
  process.exit(1);
}
console.log(`every stored document references only ${config.publicUrl}`);
