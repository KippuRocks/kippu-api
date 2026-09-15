import type { Principal, RevokedOperatorSession, Services, SessionInfo } from "../auth/ports.js";

/**
 * What every procedure receives about the request that caused it.
 *
 * Deliberately free of Fastify types, and of any runtime import: the router
 * type is published in `@kippurocks/api`, and a client compiling against it must not
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
  /**
   * When the bearer token names no live session but an operator session revoked
   * within the last 24 hours, that session. The principal stays anonymous: only
   * procedures built on `reportingOperatorProcedure` accept it.
   */
  readonly revokedOperator?: RevokedOperatorSession | null;
  readonly services: Services;
}
