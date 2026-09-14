/**
 * `pnpm metadata:publish-schemas` — stores every `@kippu/metadata-schema` schema
 * at its stable URL's object key, in the configured bucket.
 */
import { loadMetadataConfig } from "./config.js";
import { publishSchemas } from "./schemas.js";
import { createS3MetadataStorage } from "./storage.js";

const config = loadMetadataConfig();
const storage = createS3MetadataStorage(config.storage);
for (const { id, key } of await publishSchemas(storage, config.publicUrl)) {
  console.log(`published ${id} at ${key}`);
}
