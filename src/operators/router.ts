import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { OrganiserPrincipal } from "../auth/ports.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { RefusalReasonCause, toTRPCError } from "../trpc/errors.js";
import { operatorProcedure, organiserProcedure, router } from "../trpc/trpc.js";
import type {
  CheckInput,
  CreateOperatorInput,
  EnrolmentCode,
  GrantIdInput,
  GrantInput,
  ListGrantsInput,
  OperatorAccount,
  OperatorAuthorisation,
  OperatorGrant,
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

/**
 * A §10 refusal reaches the client with its code in `error.data.errorCode`; a
 * platform refusal in its transport class, with its reason in `error.data.reason`.
 */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpecCodeError) {
      throw toTRPCError(error);
    }
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

const id32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex characters");

const timestamp = z.number().int().nonnegative().max(8.64e15);

const gate = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => value.isWellFormed(), "expected well-formed Unicode");

const grantInput = z
  .object({
    operator: z.uuid(),
    event: id32,
    gates: z
      .array(gate)
      .min(1)
      .max(100)
      .refine((gates) => new Set(gates).size === gates.length, "expected distinct gates"),
    from: timestamp,
    until: timestamp,
  })
  .strict()
  .refine((input) => input.until > input.from, "expected until to be later than from");

const checkInput = z.object({ event: id32, gate }).strict();

const grantIdInput = z.object({ grant: z.uuid() }).strict();

const listGrantsInput = z
  .object({ event: id32.nullable(), operator: z.uuid().nullable() })
  .strict();

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
 *
 * Grants (`T-024-02`) scope an operator to gates of an event, for a window:
 * the organiser `create`s, `list`s and `revoke`s them, and the operator reads
 * `mine`. They change no ledger state (`AC-E5.1`).
 *
 * `check` (`T-024-03`) is what Iriguchi runs alongside `canAttend`, not in its
 * path (`AC-E5.2`).
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
  /**
   * Whether the signed-in operator may admit at the gate of the event now
   * (`AC-E5.2`). Refused as `FORBIDDEN` with a `CheckRefusal` in
   * `error.data.reason`; a revoked or ended session is `UNAUTHORIZED`. Nothing is
   * cached: a revocation refuses the next check.
   */
  check: operatorProcedure
    .input(parser<CheckInput>(checkInput))
    .query(
      ({ ctx, input }): Promise<OperatorAuthorisation> =>
        mapped(() => ctx.services.operators.check(ctx.principal, input)),
    ),
  grants: router({
    /**
     * Grants gates of an event the organiser owns — `ERR-EventNotFound`,
     * `ERR-NotOwner` otherwise — to one of their operators, from `from` until
     * strictly before `until`.
     */
    create: organiserProcedure
      .input(parser<GrantInput>(grantInput))
      .mutation(
        ({ ctx, input }): Promise<OperatorGrant> =>
          mapped(() =>
            ctx.services.operators.grant(ctx.principal.organiserId, requestOf(ctx), input),
          ),
      ),
    list: organiserProcedure
      .input(parser<ListGrantsInput>(listGrantsInput))
      .query(
        ({ ctx, input }): Promise<readonly OperatorGrant[]> =>
          mapped(() => ctx.services.operators.listGrants(ctx.principal.organiserId, input)),
      ),
    /** Revokes a grant; the operator's next check under it is refused. */
    revoke: organiserProcedure
      .input(parser<GrantIdInput>(grantIdInput))
      .mutation(
        ({ ctx, input }): Promise<OperatorGrant> =>
          mapped(() =>
            ctx.services.operators.revokeGrant(ctx.principal.organiserId, requestOf(ctx), input),
          ),
      ),
    /** The signed-in operator's grants not revoked and not ended, soonest first. */
    mine: operatorProcedure.query(
      ({ ctx }): Promise<readonly OperatorGrant[]> =>
        mapped(() => ctx.services.operators.myGrants(ctx.principal)),
    ),
  }),
});
