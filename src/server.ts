import { loadConfig } from "./config.js";
import { loadMetadataConfig, loadMetadataPublicUrl } from "./metadata/config.js";
import { createS3MetadataStorage } from "./metadata/storage.js";
import { assertMigrated } from "./store/migrate.js";
import { createStore } from "./store/store.js";
import { createServer, type KippuServer } from "./wiring.js";

const config = loadConfig();
const store = createStore(config.databaseUrl);
let server: KippuServer;
try {
  // Metadata storage is optional in development: without it, document editing fails and
  // reads join no documents (F-026, REQ-MD-2).
  const storage =
    process.env.KIPPU_METADATA_S3_BUCKET === undefined
      ? undefined
      : createS3MetadataStorage(loadMetadataConfig().storage);
  server = createServer(
    config,
    store,
    { logger: true },
    {
      metadataPublicUrl: loadMetadataPublicUrl(),
      ...(storage === undefined ? {} : { metadataStorage: storage }),
    },
  );
  server.app.log.warn(
    { ledgerEnvironment: config.ledgerEnvironment, metadataStorage: storage !== undefined },
    "serving over backend-memory, a software KMS and a development sponsor: ledger state and " +
      "organiser keys live in this process's memory and are lost when it exits",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await store.end();
  process.exit(1);
}

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  server.app.log.info({ signal }, "shutting down");
  await server.close();
  await store.end();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await assertMigrated(store);
  server.start();
  await server.app.listen({ host: config.host, port: config.port });
} catch (error) {
  server.app.log.error(error);
  await server.close();
  await store.end();
  process.exit(1);
}
