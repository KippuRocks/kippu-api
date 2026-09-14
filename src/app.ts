import type { AnyTRPCRouter, TRPCError } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { Services } from "./auth/ports.js";
import { makeCreateContext } from "./trpc/fastify-context.js";
import { appRouter } from "./trpc/router.js";

/** Where the `C5` tRPC contract is served. */
export const TRPC_PREFIX = "/v0/trpc";

/** The largest tRPC request body, in bytes: an image upload's base64 and its envelope (`T-026-06`). */
export const TRPC_BODY_LIMIT = 4 * 1024 * 1024;

/**
 * Builds the Kippu API's HTTP application without binding a port, so tests can
 * drive it through `inject` or a real client.
 *
 * Services not given fail every call, for tests and deployments that do not need them.
 *
 * `GET /health` is an operational endpoint: it sits outside the versioned API
 * prefix and is not part of the `C5` contract.
 */
export function buildApp(
  options: FastifyServerOptions = {},
  trpcRouter: AnyTRPCRouter = appRouter,
  given: Partial<Services> = {},
): FastifyInstance {
  const services: Services = { ...unavailableServices(), ...given };
  const app = Fastify({
    ...options,
    // tRPC batches procedure paths into the URL.
    routerOptions: { maxParamLength: 5000, ...options.routerOptions },
  });

  app.get("/health", async () => ({ status: "ok" }) as const);

  // Big enough for an uploaded image in base64 (`MAX_IMAGE_BYTES`), for tRPC calls
  // only; every other route keeps Fastify's default.
  app.register(async (scope) => {
    scope.addHook("onRoute", (route) => {
      route.bodyLimit = TRPC_BODY_LIMIT;
    });
    await scope.register(fastifyTRPCPlugin, {
      prefix: TRPC_PREFIX,
      trpcOptions: {
        router: trpcRouter,
        createContext: makeCreateContext(services),
        onError({
          error,
          path,
          req,
        }: {
          error: TRPCError;
          path?: string | undefined;
          req: FastifyRequest;
        }) {
          if (error.code === "INTERNAL_SERVER_ERROR") {
            req.log.error({ err: error.cause ?? error, path }, "procedure failed");
          }
        },
      },
    });
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
      beginHolderLink: unavailable,
      completeHolderLink: unavailable,
      authenticate: unavailable,
      signOut: unavailable,
    },
    events: unavailableService<Services["events"]>(),
    metadata: unavailableService<Services["metadata"]>(),
    derived: unavailableService<Services["derived"]>(),
  };
}

/** A service whose every method fails. */
function unavailableService<T extends object>(): T {
  return new Proxy({} as T, { get: () => unavailable });
}
