import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { ANONYMOUS, type Services, type SessionInfo } from "../auth/ports.js";
import type { Context } from "./context.js";

const BEARER = /^Bearer ([A-Za-z0-9_-]{16,256})$/;

/** The bearer token in an `Authorization` header, or `null`. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }
  return BEARER.exec(header)?.[1] ?? null;
}

/**
 * Builds a procedure's context from the Fastify request that carries it. A
 * missing, malformed, expired or revoked token yields no session, and the call
 * acts as the anonymous principal (`REQ-MP-7`).
 */
export function makeCreateContext(services: Services) {
  return async ({ req }: CreateFastifyContextOptions): Promise<Context> => {
    const token = bearerToken(req.headers.authorization);
    const session: SessionInfo | null =
      token === null ? null : await services.auth.authenticate(token);
    return { requestId: req.id, session, principal: session?.principal ?? ANONYMOUS, services };
  };
}
