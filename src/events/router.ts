import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { OrganiserPrincipal } from "../auth/ports.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { toTRPCError } from "../trpc/errors.js";
import { organiserProcedure, router } from "../trpc/trpc.js";
import type {
  AddSeatPositionsInput,
  AddZoneInput,
  CreatedEvent,
  CreateEventInput,
  DefineClassInput,
  EventInput,
  EventsRequest,
  IssuedTicket,
  IssueGrantedInput,
  Recorded,
  SeatPositions,
  TicketClass,
  ZoneInput,
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
 * refusal §10 has no code for, as `BAD_REQUEST` with its message.
 */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpecCodeError) {
      throw toTRPCError(error);
    }
    if (error instanceof RefusedRequest) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
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

const zone = z.object({ id: id32, kind: z.enum(["Seated", "Unseated"]) }).strict();

const zoneInput = z.object({ event: id32, zone: id32 }).strict();

const addZoneInput = z.object({ event: id32, zone }).strict();

const designation = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.isWellFormed(), "expected well-formed Unicode");

const addSeatPositionsInput = z
  .object({ event: id32, zone: id32, positions: z.array(designation).min(1).max(50_000) })
  .strict();

const issueGrantedInput = z
  .object({
    event: id32,
    class: id32,
    zone: id32,
    placement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("Seated"), position: designation }).strict(),
      z.object({ kind: z.literal("Unseated") }).strict(),
    ]),
    holder: id32,
  })
  .strict();

const createEventInput = z
  .object({
    zones: z.array(zone).max(1000),
    capacity: count.nullable(),
  })
  .strict();

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
 * Zones (`REQ-ID-7`) and the canonical seat positions of seated zones
 * (`REQ-ID-3`; `F-021` plan §5.3). Adding and removing a zone are ledger writes;
 * the ledger's verdict — `ERR-ZoneExists`, `ERR-ZoneInUse`, `ERR-EventSealed` —
 * is passed on unchanged.
 */
const zonesRouter = router({
  add: organiserProcedure
    .input(parser<AddZoneInput>(addZoneInput))
    .mutation(
      ({ ctx, input }): Promise<Recorded> =>
        mapped(() => ctx.services.events.addZone(ctx.principal.organiserId, requestOf(ctx), input)),
    ),
  remove: organiserProcedure
    .input(parser<ZoneInput>(zoneInput))
    .mutation(
      ({ ctx, input }): Promise<Recorded> =>
        mapped(() =>
          ctx.services.events.removeZone(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  /**
   * Adds canonical positions to a seated zone. Positions already on the list are
   * kept once; the answer is the whole list. Issuance accepts only a position on
   * it, matched exactly.
   */
  addSeatPositions: organiserProcedure
    .input(parser<AddSeatPositionsInput>(addSeatPositionsInput))
    .mutation(
      ({ ctx, input }): Promise<SeatPositions> =>
        mapped(() =>
          ctx.services.events.addSeatPositions(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  seatPositions: organiserProcedure
    .input(parser<ZoneInput>(zoneInput))
    .query(
      ({ ctx, input }): Promise<SeatPositions> =>
        mapped(() => ctx.services.events.seatPositions(ctx.principal.organiserId, input)),
    ),
});

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

/** Granted tickets (`US-B2`, `REQ-TC-4`). */
const ticketsRouter = router({
  /**
   * Issues a ticket from a granted class to a holder's account: free, with no
   * payment record of any kind. A seat must be one of its zone's canonical
   * positions. Refused by Kippu with `ERR-UnknownClass` or
   * `ERR-ClassQuotaExceeded`, and by the ledger with its own §10 codes —
   * `ERR-CapacityExceeded` and `ERR-TicketIdExists` among them.
   */
  issueGranted: organiserProcedure
    .input(parser<IssueGrantedInput>(issueGrantedInput))
    .mutation(
      ({ ctx, input }): Promise<IssuedTicket> =>
        mapped(() =>
          ctx.services.events.issueGranted(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
});

/**
 * Events, zones, classes and granted issuance (`F-021`). Every procedure is the
 * organiser's: Kippu exercises their ledger authority for them (`REQ-OA-1`).
 */
export const eventsRouter = router({
  /**
   * Creates an event owned by the organiser, `Active`, with its zones and an
   * optional capacity (`US-A1`). Answers once the ledger has recorded it, with
   * the event's id and the receipt's log cursor.
   */
  create: organiserProcedure
    .input(parser<CreateEventInput>(createEventInput))
    .mutation(
      ({ ctx, input }): Promise<CreatedEvent> =>
        mapped(() =>
          ctx.services.events.createEvent(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  zones: zonesRouter,
  classes: classesRouter,
  tickets: ticketsRouter,
});
