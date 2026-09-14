import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertMigrated } from "./store/migrate.js";
import { createStore } from "./store/store.js";

const config = loadConfig();
const store = createStore(config.databaseUrl);
const app = buildApp({ logger: true });

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
