import { initTRPC, TRPCError } from "@trpc/server";
import type {
  HolderPrincipal,
  OperatorPrincipal,
  OrganiserPrincipal,
  SessionInfo,
} from "../auth/ports.js";
import type { Context } from "./context.js";
import { SpecErrorCause } from "./errors.js";

/** The §10 code, when the error carries one; `null` otherwise. */
export interface KippuErrorData {
  readonly errorCode: string | null;
}

/**
 * Who may call a procedure. `public` procedures are open to the anonymous
 * principal (`REQ-MP-7`); every other procedure — including one that declares
 * nothing — refuses it.
 */
export interface ProcedureMeta {
  readonly access?: "public" | "signed-in" | undefined;
}

/** What a client sees of any error Kippu did not mean to show it. */
export const INTERNAL_ERROR_MESSAGE = "internal error";

const t = initTRPC
  .context<Context>()
  .meta<ProcedureMeta>()
  .create({
    errorFormatter({ shape, error }) {
      const data: KippuErrorData = {
        errorCode: error.cause instanceof SpecErrorCause ? error.cause.specCode : null,
      };
      // An internal error reaches the client with no detail: no message from
      // wherever it arose, and never a stack (`F-020` plan §5.5). The server logs it.
      const { stack: _stack, ...rest } = shape.data;
      const internal = error.code === "INTERNAL_SERVER_ERROR";
      return {
        ...shape,
        message: internal ? INTERNAL_ERROR_MESSAGE : shape.message,
        data: { ...rest, ...data },
      };
    },
  });

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

/**
 * The base of every exported builder. The anonymous principal reaches a
 * procedure only when the procedure is declared public, so a procedure that
 * forgets to say is closed, not open.
 */
const guarded = t.procedure.use(({ ctx, meta, next }) => {
  if (ctx.principal.kind === "anonymous" && meta?.access !== "public") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in first" });
  }
  return next();
});

/** A procedure anyone may call, with or without a session (`REQ-MP-7`). */
export const publicProcedure = guarded.meta({ access: "public" });

/** A procedure any signed-in principal may call. */
export const authenticatedProcedure = guarded.meta({ access: "signed-in" }).use(({ ctx, next }) => {
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

/** A procedure only a linked holder may call. */
export const holderProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  const { principal } = ctx.session;
  if (principal.kind !== "holder") {
    throw new TRPCError({ code: "FORBIDDEN", message: "only a holder may do this" });
  }
  return next({ ctx: { ...ctx, principal: principal as HolderPrincipal } });
});
