import type { AnyTRPCRouter } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Services } from "./auth/ports.js";
import { makeCreateContext } from "./trpc/fastify-context.js";
import { appRouter } from "./trpc/router.js";

/** Where the `C5` tRPC contract is served. */
export const TRPC_PREFIX = "/v0/trpc";

/**
 * Builds the Kippu API's HTTP application without binding a port, so tests can
 * drive it through `inject` or a real client.
 *
 * `services` default to ones that fail every call, for tests that need no store.
 *
 * `GET /health` is an operational endpoint: it sits outside the versioned API
 * prefix and is not part of the `C5` contract.
 */
export function buildApp(
  options: FastifyServerOptions = {},
  trpcRouter: AnyTRPCRouter = appRouter,
  services: Services = unavailableServices(),
): FastifyInstance {
  const app = Fastify({
    ...options,
    // tRPC batches procedure paths into the URL.
    routerOptions: { maxParamLength: 5000, ...options.routerOptions },
  });

  app.get("/health", async () => ({ status: "ok" }) as const);

  app.register(fastifyTRPCPlugin, {
    prefix: TRPC_PREFIX,
    trpcOptions: { router: trpcRouter, createContext: makeCreateContext(services) },
  });

  return app;
}

function unavailable(): never {
  throw new Error("no services are configured for this application");
}

function unavailableServices(): Services {
  return {
    auth: {
      beginOrganiserSignUp: unavailable,
      completeOrganiserSignUp: unavailable,
      beginOrganiserSignIn: unavailable,
      completeOrganiserSignIn: unavailable,
      redeemOperatorEnrolmentCode: unavailable,
      authenticate: unavailable,
      signOut: unavailable,
    },
  };
}
