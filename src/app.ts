import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

/**
 * Builds the Kippu API's HTTP application without binding a port, so tests can
 * drive it through `inject`.
 *
 * Only the operational health endpoint exists so far. It sits outside any
 * versioned API prefix and is not part of the `C5` contract.
 */
export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get("/health", async () => ({ status: "ok" }) as const);

  return app;
}
