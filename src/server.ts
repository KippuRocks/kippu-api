import { buildApp } from "./app.js";

const DEFAULT_PORT = 8080;

function readPort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

const app = buildApp({ logger: true });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: readPort(process.env.PORT),
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
