import { initTRPC, TRPCError } from "@trpc/server";
import type { OperatorPrincipal, OrganiserPrincipal, SessionInfo } from "../auth/ports.js";
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

/** A procedure any signed-in principal may call. */
export const authenticatedProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.session === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in first" });
  }
  return next({ ctx: { ...ctx, session: ctx.session as SessionInfo } });
});

/** A procedure only an organiser may call. */
export const organiserProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  const { principal } = ctx.session;
  if (principal.kind !== "organiser") {
    throw new TRPCError({ code: "FORBIDDEN", message: "only an organiser may do this" });
  }
  return next({ ctx: { ...ctx, principal: principal as OrganiserPrincipal } });
});

/** A procedure only an operator may call. */
export const operatorProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  const { principal } = ctx.session;
  if (principal.kind !== "operator") {
    throw new TRPCError({ code: "FORBIDDEN", message: "only an operator may do this" });
  }
  return next({ ctx: { ...ctx, principal: principal as OperatorPrincipal } });
});
