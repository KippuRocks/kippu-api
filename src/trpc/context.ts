import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";

/**
 * What every procedure receives about the request that caused it.
 *
 * Deliberately free of Fastify types: the router type is published in
 * `@kippu/api`, and a client compiling against it must not need the server's
 * HTTP framework. Principals and sessions join this context in later tasks.
 */
export interface Context {
  /** Identifies the HTTP request, so later work can attribute what it caused. */
  readonly requestId: string;
}

export function createContext({ req }: CreateFastifyContextOptions): Context {
  return { requestId: req.id };
}
