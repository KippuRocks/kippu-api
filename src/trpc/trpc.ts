import { initTRPC } from "@trpc/server";
import type { Context } from "./context.js";
import { SpecErrorCause } from "./errors.js";

/** The §10 code, when the error carries one; `null` otherwise. */
export interface KippuErrorData {
  readonly errorCode: string | null;
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const data: KippuErrorData = {
      errorCode: error.cause instanceof SpecErrorCause ? error.cause.specCode : null,
    };
    return { ...shape, data: { ...shape.data, ...data } };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;
