import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { OrganiserPrincipal } from "../auth/ports.js";
import { RefusedRequest } from "../authority/errors.js";
import { RefusalReasonCause } from "../trpc/errors.js";
import { organiserProcedure, router } from "../trpc/trpc.js";
import type {
  CreateOperatorInput,
  EnrolmentCode,
  OperatorAccount,
  OperatorInput,
  OperatorsRequest,
  RevokedSessions,
} from "./ports.js";

/**
 * Validates with a schema, and types the input as `T` — a type declared without
 * imports, so the published router type never refers to the validator.
 */
function parser<T>(schema: z.ZodType): (value: unknown) => T {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new TRPCError({ code: "BAD_REQUEST", message: z.prettifyError(result.error) });
    }
    return result.data as T;
  };
}

/** A refusal reaches the client in its transport class, with its reason in `error.data.reason`. */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RefusedRequest) {
      throw new TRPCError({
        code: error.transport,
        message: error.message,
        ...(error.reason === null ? {} : { cause: new RefusalReasonCause(error.reason) }),
      });
    }
    throw error;
  }
}

const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => value.isWellFormed(), "expected well-formed Unicode");

const createOperatorInput = z.object({ name }).strict();

const operatorInput = z.object({ operator: z.uuid() }).strict();

const requestOf = (ctx: {
  readonly requestId: string;
  readonly principal: OrganiserPrincipal;
}): OperatorsRequest => ({ requestId: ctx.requestId, principal: ctx.principal });

/**
 * Operator authorisation (`F-024`; `US-E5`). The ledger never learns who an
 * operator is (`REQ-OP-1`): nothing here writes to it.
 *
 * Operator accounts (`T-024-01`) are the organiser's: `create` and `list`;
 * `issueEnrolmentCode`, whose code Iriguchi redeems with
 * `auth.operator.redeemEnrolmentCode`; and `revokeSessions`. An operator of
 * another organiser is `NOT_FOUND`, reason `unknown-operator`.
 */
export const operatorsRouter = router({
  create: organiserProcedure
    .input(parser<CreateOperatorInput>(createOperatorInput))
    .mutation(
      ({ ctx, input }): Promise<OperatorAccount> =>
        mapped(() =>
          ctx.services.operators.create(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  list: organiserProcedure.query(
    ({ ctx }): Promise<readonly OperatorAccount[]> =>
      mapped(() => ctx.services.operators.list(ctx.principal.organiserId)),
  ),
  issueEnrolmentCode: organiserProcedure
    .input(parser<OperatorInput>(operatorInput))
    .mutation(
      ({ ctx, input }): Promise<EnrolmentCode> =>
        mapped(() =>
          ctx.services.operators.issueEnrolmentCode(
            ctx.principal.organiserId,
            requestOf(ctx),
            input,
          ),
        ),
    ),
  revokeSessions: organiserProcedure
    .input(parser<OperatorInput>(operatorInput))
    .mutation(
      ({ ctx, input }): Promise<RevokedSessions> =>
        mapped(() =>
          ctx.services.operators.revokeSessions(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
});
