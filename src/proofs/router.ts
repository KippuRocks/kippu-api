import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { RefusalReasonCause, toTRPCError } from "../trpc/errors.js";
import { organiserProcedure, reviewerProcedure, router } from "../trpc/trpc.js";
import type {
  CapacityProofRequest,
  CapacityProofRequestInput,
  ProofArtefact,
  RequestCapacityIncreaseInput,
  ReviewedCapacityProofRequest,
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

/** §10 codes in `error.data.errorCode`; platform refusals by their transport class and reason. */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpecCodeError) throw toTRPCError(error);
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

const id32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex characters");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Type, size and signature are the service's to check (`src/proofs/artefacts.ts`). */
const requestInput = z
  .object({
    event: id32,
    capacity: count.nullable(),
    artefact: z
      .object({ mediaType: z.string().max(100), data: z.string().min(1).max(3_000_000) })
      .strict(),
  })
  .strict();

const decisionInput = z.object({ request: z.uuid() }).strict();

/**
 * An organiser's capacity increases (`T-021-08`; `US-A6`, `REQ-EV-5`, `REQ-EV-7`),
 * mounted at `events.capacityProofs`. A request stores its artefact privately
 * and waits for a Kippu reviewer; nothing reaches the ledger until one approves.
 */
export const organiserCapacityProofsRouter = router({
  /**
   * Asks for an increase — a higher capacity, or `null` to remove the bound — with
   * an artefact attesting the venue supports it (PDF, JPEG or PNG, at most 2 MiB).
   * `BAD_REQUEST` with `error.data.reason` `not-an-increase` or `artefact`;
   * `CONFLICT` with `pending` while another request for the event is pending.
   */
  request: organiserProcedure
    .input(parser<RequestCapacityIncreaseInput>(requestInput))
    .mutation(
      ({ ctx, input }): Promise<CapacityProofRequest> =>
        mapped(() =>
          ctx.services.capacityProofs.request(
            ctx.principal.organiserId,
            { requestId: ctx.requestId, principal: ctx.principal },
            input,
          ),
        ),
    ),
  /** Every capacity proof request for the event, newest first, with its review status. */
  list: organiserProcedure
    .input(parser<{ readonly event: string }>(z.object({ event: id32 }).strict()))
    .query(
      ({ ctx, input }): Promise<CapacityProofRequest[]> =>
        mapped(() => ctx.services.capacityProofs.list(ctx.principal.organiserId, input)),
    ),
});

/**
 * The capacity proof review queue (`T-021-08`; `REQ-EV-6`; `F-021` plan §5.4),
 * mounted at `reviewers.capacityProofs`: reviewer sessions only, never an
 * organiser's. Every decision records the reviewer and the time; an approval
 * submits the increase with a random proof id, audited as the reviewer's request.
 */
export const reviewerCapacityProofsRouter = router({
  /** The pending requests, oldest first. */
  queue: reviewerProcedure.query(
    ({ ctx }): Promise<ReviewedCapacityProofRequest[]> =>
      mapped(() => ctx.services.capacityProofs.queue()),
  ),
  /** A request's artefact, in base64. */
  artefact: reviewerProcedure
    .input(parser<CapacityProofRequestInput>(decisionInput))
    .query(
      ({ ctx, input }): Promise<ProofArtefact> =>
        mapped(() => ctx.services.capacityProofs.artefact(input)),
    ),
  /**
   * Approves a pending request and submits the increase with a proof id. The
   * ledger's refusal is passed on in `error.data.errorCode` and leaves the request
   * pending; `CONFLICT` with reason `decided` once it was decided.
   */
  approve: reviewerProcedure
    .input(parser<CapacityProofRequestInput>(decisionInput))
    .mutation(
      ({ ctx, input }): Promise<ReviewedCapacityProofRequest> =>
        mapped(() =>
          ctx.services.capacityProofs.approve(
            { requestId: ctx.requestId, principal: ctx.principal },
            input,
          ),
        ),
    ),
  /** Rejects a pending request; `CONFLICT` with reason `decided` once it was decided. */
  reject: reviewerProcedure
    .input(parser<CapacityProofRequestInput>(decisionInput))
    .mutation(
      ({ ctx, input }): Promise<ReviewedCapacityProofRequest> =>
        mapped(() =>
          ctx.services.capacityProofs.reject(
            { requestId: ctx.requestId, principal: ctx.principal },
            input,
          ),
        ),
    ),
});
