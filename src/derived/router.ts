import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { RefusedRequest } from "../authority/errors.js";
import {
  authenticatedProcedure,
  holderProcedure,
  organiserProcedure,
  publicProcedure,
  router,
} from "../trpc/trpc.js";
import type { EventRead, EventsOnSalePage, EventsRead, HoldingsRead, WaitedFor } from "./ports.js";

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

const id32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex characters");

const eventInput = z.object({ event: id32 }).strict();

/** How many events a page of the index holds, unless a client asks for fewer or more. */
export const DEFAULT_PAGE_SIZE = 20;

const eventsOnSaleInput = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    page: z.string().max(200).nullable().optional(),
  })
  .strict()
  .optional();

const waitForInput = z
  .object({ cursor: z.string().max(1024), timeout: z.number().int().min(0).max(10_000) })
  .strict();

/**
 * Reads of ledger facts from Kippu's derived copy, each joined with its public
 * metadata and stating how fresh it is (`F-025`, `AC-A3.2`, `NFR-11`). Nothing
 * here is authoritative (`REQ-IX-1`): the ledger is.
 */
export const derivedRouter = router({
  events: router({
    /**
     * An event as one object of ledger facts and metadata (`AC-A3.2`). Public:
     * Ichiba's event pages need no session (`REQ-MP-7`). `event` is `null` when
     * the copy holds no such event.
     */
    get: publicProcedure
      .input(parser<{ event: string }>(eventInput))
      .query(({ ctx, input }): Promise<EventRead> => ctx.services.derived.event(input.event)),
    /**
     * Ichiba's index: the events on sale — `Active`, with a `Purchased` class —
     * each as `get` returns it, most recently created first, `limit` (default 20,
     * at most 100) to a page. Public (`REQ-MP-7`). Cancelled, finished and
     * sealed events are not listed. Pass `nextPage` back as `page` to continue.
     */
    onSale: publicProcedure
      .input(parser<{ limit?: number; page?: string | null } | undefined>(eventsOnSaleInput))
      .query(async ({ ctx, input }): Promise<EventsOnSalePage> => {
        try {
          return await ctx.services.derived.eventsOnSale(
            input?.limit ?? DEFAULT_PAGE_SIZE,
            input?.page ?? null,
          );
        } catch (error) {
          if (error instanceof RefusedRequest) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
          }
          throw error;
        }
      }),
    /** Ibento: the events the organiser owns on the ledger, most recently created first. */
    mine: organiserProcedure.query(
      ({ ctx }): Promise<EventsRead> =>
        ctx.services.derived.organiserEvents(ctx.principal.organiserId),
    ),
  }),
  holdings: router({
    /** Saifu: the tickets the linked holder's account holds, each with its class metadata and event. */
    mine: holderProcedure.query(
      ({ ctx }): Promise<HoldingsRead> => ctx.services.derived.holdings(ctx.principal.account),
    ),
  }),
  /**
   * Waits, at most `timeout` ms (up to 10 s), until the copy reflects the record
   * at a write's receipt cursor, so a client shows the new state without guessing.
   */
  waitFor: authenticatedProcedure
    .input(parser<{ cursor: string; timeout: number }>(waitForInput))
    .query(
      ({ ctx, input }): Promise<WaitedFor> =>
        ctx.services.derived.waitFor(input.cursor, input.timeout),
    ),
});
