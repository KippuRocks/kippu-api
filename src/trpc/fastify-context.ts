import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { Context } from "./context.js";

/** Builds a procedure's context from the Fastify request that carries it. */
export function createContext({ req }: CreateFastifyContextOptions): Context {
  return { requestId: req.id };
}
