import { loadConfig } from "./config.js";
import { loadMetadataConfig } from "./metadata/config.js";
import { assertMigrated } from "./store/migrate.js";
import { createStore } from "./store/store.js";
import { createServer } from "./wiring.js";

const config = loadConfig();
const store = createStore(config.databaseUrl);
let app: ReturnType<typeof createServer>["app"];
try {
  // Metadata editing is mounted when its object storage is configured (F-026).
  const metadata =
    process.env.KIPPU_METADATA_S3_BUCKET === undefined ? undefined : loadMetadataConfig();
  ({ app } = createServer(
    config,
    store,
    { logger: true },
    metadata === undefined ? {} : { metadata },
  ));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await store.end();
  process.exit(1);
}
// Production is refused above, so this process serves the development wiring.
app.log.warn(
  { ledgerEnvironment: config.ledgerEnvironment },
  "serving over backend-memory, a software KMS and a development sponsor: ledger state and " +
    "organiser keys live in this process's memory and are lost when it exits",
);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await store.end();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await assertMigrated(store);
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await store.end();
  process.exit(1);
}
