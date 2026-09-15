import { initTRPC, TRPCError } from "@trpc/server";
import type {
  HolderPrincipal,
  OperatorPrincipal,
  OrganiserPrincipal,
  ReviewerPrincipal,
  RevokedOperatorSession,
  SessionInfo,
} from "../auth/ports.js";
import type { Context } from "./context.js";
import { RefusalReasonCause, SpecErrorCause } from "./errors.js";

/** What a failed call carries beyond tRPC's own error shape. */
export interface KippuErrorData {
  /** The §10 code, when the error carries one; `null` otherwise. */
  readonly errorCode: string | null;
  /**
   * A machine-readable platform reason, when a procedure documents one — such as
   * why an invitation's redemption was refused. Not a §10 code; `null` otherwise.
   */
  readonly reason: string | null;
}

/**
 * Who may call a procedure. `public` procedures are open to the anonymous
 * principal (`REQ-MP-7`); every other procedure — including one that declares
 * nothing — refuses it. `operator-report` procedures also admit an operator
 * session revoked within the last 24 hours, and no other anonymous call.
 */
export interface ProcedureMeta {
  readonly access?: "public" | "signed-in" | "operator-report" | undefined;
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
        reason:
          error.cause instanceof SpecErrorCause || error.cause instanceof RefusalReasonCause
            ? error.cause.reason
            : null,
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
  const reporting = meta?.access === "operator-report" && (ctx.revokedOperator ?? null) !== null;
  if (ctx.principal.kind === "anonymous" && meta?.access !== "public" && !reporting) {
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

/**
 * A procedure only a Kippu operations reviewer may call (`T-021-16`): never an
 * organiser, so no organiser session reaches the capacity-proof review queue.
 */
export const reviewerProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  const { principal } = ctx.session;
  if (principal.kind !== "reviewer") {
    throw new TRPCError({ code: "FORBIDDEN", message: "only a Kippu reviewer may do this" });
  }
  return next({ ctx: { ...ctx, principal: principal as ReviewerPrincipal } });
});

/**
 * A procedure an operator may call in a live session, or in one revoked within
 * the last 24 hours (`F-024` plan §5.4). `sessionRevokedAt` says which: `null` for
 * a live session. Only `operators.reportAdmission` is built on it.
 */
export const reportingOperatorProcedure = guarded
  .meta({ access: "operator-report" })
  .use(({ ctx, next }) => {
    if (ctx.session !== null) {
      const { principal } = ctx.session;
      if (principal.kind !== "operator") {
        throw new TRPCError({ code: "FORBIDDEN", message: "only an operator may do this" });
      }
      return next({
        ctx: { ...ctx, principal: principal as OperatorPrincipal, sessionRevokedAt: null },
      });
    }
    const revoked = (ctx.revokedOperator ?? null) as RevokedOperatorSession | null;
    if (revoked === null) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in first" });
    }
    return next({
      ctx: {
        ...ctx,
        principal: revoked.principal,
        sessionRevokedAt: Date.parse(revoked.revokedAt) as number | null,
      },
    });
  });
