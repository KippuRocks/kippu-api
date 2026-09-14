import type { Principal, Services, SessionInfo } from "../auth/ports.js";

/**
 * What every procedure receives about the request that caused it.
 *
 * Deliberately free of Fastify types, and of any runtime import: the router
 * type is published in `@kippu/api`, and a client compiling against it must not
 * need the server's HTTP framework, driver or WebAuthn library. Everything
 * named here is declared in modules that import nothing but each other.
 */
export interface Context {
  /** Identifies the HTTP request, so later work can attribute what it caused. */
  readonly requestId: string;
  /** The live session the request's bearer token names, or `null` when it names none. */
  readonly session: SessionInfo | null;
  /** The session's principal, or the anonymous principal when there is no session. */
  readonly principal: Principal;
  readonly services: Services;
}
