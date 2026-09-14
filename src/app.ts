import type { AnyTRPCRouter } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createContext } from "./trpc/fastify-context.js";
import { appRouter } from "./trpc/router.js";

/** Where the `C5` tRPC contract is served. */
export const TRPC_PREFIX = "/v0/trpc";

/**
 * Builds the Kippu API's HTTP application without binding a port, so tests can
 * drive it through `inject` or a real client.
 *
 * `GET /health` is an operational endpoint: it sits outside the versioned API
 * prefix and is not part of the `C5` contract.
 */
export function buildApp(
  options: FastifyServerOptions = {},
  trpcRouter: AnyTRPCRouter = appRouter,
): FastifyInstance {
  const app = Fastify({
    ...options,
    // tRPC batches procedure paths into the URL.
    routerOptions: { maxParamLength: 5000, ...options.routerOptions },
  });

  app.get("/health", async () => ({ status: "ok" }) as const);

  app.register(fastifyTRPCPlugin, {
    prefix: TRPC_PREFIX,
    trpcOptions: { router: trpcRouter, createContext },
  });

  return app;
}
