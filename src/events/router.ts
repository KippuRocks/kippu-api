import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { OrganiserPrincipal } from "../auth/ports.js";
import { SpecCodeError } from "../authority/errors.js";
import { toTRPCError } from "../trpc/errors.js";
import { organiserProcedure, router } from "../trpc/trpc.js";
import type { DefineClassInput, EventInput, EventsRequest, TicketClass } from "./ports.js";

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

/** A §10 refusal reaches the client with its code in `error.data.errorCode`. */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpecCodeError) {
      throw toTRPCError(error);
    }
    throw error;
  }
}

const id32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex characters");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const policy = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Single") }).strict(),
  z.object({ kind: z.literal("Multiple"), max: count, until: timestamp.nullable() }).strict(),
  z.object({ kind: z.literal("Unlimited"), until: timestamp.nullable() }).strict(),
]);

const eventInput = z.object({ event: id32 }).strict();

const defineClassInput = z
  .object({
    event: id32,
    name: z.string().min(1).max(200),
    description: z.string().max(5000).nullable(),
    provenance: z.enum(["Purchased", "Granted"]),
    policy,
    restrictions: z.object({ cannotResale: z.boolean(), cannotTransfer: z.boolean() }).strict(),
    quota: count.nullable(),
  })
  .strict();

/** The request a procedure acts on behalf of, for the audit log (`NFR-7`). */
const requestOf = (ctx: {
  readonly requestId: string;
  readonly principal: OrganiserPrincipal;
}): EventsRequest => ({ requestId: ctx.requestId, principal: ctx.principal });

/**
 * Ticket classes (`US-B2`). A class declared `Purchased` with a restriction is
 * refused at definition with `ERR-RestrictionNotPermitted` (`REQ-TC-3`).
 */
const classesRouter = router({
  define: organiserProcedure
    .input(parser<DefineClassInput>(defineClassInput))
    .mutation(
      ({ ctx, input }): Promise<TicketClass> =>
        mapped(() =>
          ctx.services.events.defineClass(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  list: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .query(
      ({ ctx, input }): Promise<readonly TicketClass[]> =>
        mapped(() => ctx.services.events.listClasses(ctx.principal.organiserId, input)),
    ),
});

/**
 * Events, zones, classes and granted issuance (`F-021`). Every procedure is the
 * organiser's: Kippu exercises their ledger authority for them (`REQ-OA-1`).
 */
export const eventsRouter = router({
  classes: classesRouter,
});
