/**
 * `pnpm metadata:edge` — the local stand-in for the metadata CDN, serving the
 * configured bucket (`src/metadata/edge.ts`).
 */
import { loadMetadataEdgeConfig } from "./config.js";
import { buildMetadataEdge } from "./edge.js";
import { createS3MetadataStorage } from "./storage.js";

const config = loadMetadataEdgeConfig();
const app = buildMetadataEdge(
  { storage: createS3MetadataStorage(config.storage) },
  { logger: true },
);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
