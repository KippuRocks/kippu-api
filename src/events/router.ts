import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { HolderPrincipal, OrganiserPrincipal } from "../auth/ports.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { organiserCapacityProofsRouter } from "../proofs/router.js";
import { RefusalReasonCause, toTRPCError } from "../trpc/errors.js";
import { holderProcedure, organiserProcedure, router } from "../trpc/trpc.js";
import type {
  AddSeatPositionsInput,
  AddZoneInput,
  CapacityChanged,
  CreatedEvent,
  CreatedInvitation,
  CreateEventInput,
  CreateInvitationInput,
  DecreaseCapacityInput,
  DefineClassInput,
  EventInput,
  EventPassWindow,
  EventSaleAsset,
  EventsRequest,
  FinishSchedule,
  Invitation,
  InvitationRefusal,
  IssuedTicket,
  IssueGrantedInput,
  ListInvitationsInput,
  Recorded,
  RedeemedInvitation,
  RedeemInvitationInput,
  RemoveRestrictionInput,
  RestrictionRemoved,
  ScheduleFinishInput,
  SeatPositions,
  SetClassPriceInput,
  SetPassWindowInput,
  SetSaleAssetInput,
  StatusChanged,
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

const saleAsset = z.enum(["COPM/2", "DUSD/6"]);
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

const placementInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Seated"), position: designation }).strict(),
  z.object({ kind: z.literal("Unseated") }).strict(),
]);

const issueGrantedInput = z
  .object({
    event: id32,
    class: id32,
    zone: id32,
    placement: placementInput,
    holder: id32,
  })
  .strict();

const createInvitationInput = z
  .object({
    event: id32,
    class: id32,
    zone: id32,
    placement: placementInput,
    guest: z.string().min(1).max(200).nullable(),
  })
  .strict();

const listInvitationsInput = z.object({ event: id32, class: id32.nullable() }).strict();

const redeemInvitationInput = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected an invitation token") })
  .strict();

const createEventInput = z
  .object({
    zones: z.array(zone).max(1000),
    capacity: count.nullable(),
    saleAsset: saleAsset.nullable().optional(),
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
    price: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  })
  .strict();

const setSaleAssetInput = z.object({ event: id32, asset: saleAsset }).strict();

const removeRestrictionInput = z
  .object({ event: id32, ticket: id32, restriction: z.enum(["cannotResale", "cannotTransfer"]) })
  .strict();

const decreaseCapacityInput = z.object({ event: id32, capacity: count }).strict();

const scheduleFinishInput = z
  .object({ event: id32, at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();

// Milliseconds; the bounds are checked by the service, whose maximum is the ledger's.
const setPassWindowInput = z
  .object({ event: id32, windowMs: z.number().int().positive().max(2_147_483_647) })
  .strict();

const setClassPriceInput = z
  .object({
    event: id32,
    class: id32,
    price: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** The request a procedure acts on behalf of, for the audit log (`NFR-7`). */
const requestOf = (ctx: {
  readonly requestId: string;
  readonly principal: OrganiserPrincipal | HolderPrincipal;
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
  /** Sets a `Purchased` class's price, in the sale asset's minor units, for holds placed from now on. */
  setPrice: organiserProcedure
    .input(parser<SetClassPriceInput>(setClassPriceInput))
    .mutation(
      ({ ctx, input }): Promise<TicketClass> =>
        mapped(() =>
          ctx.services.events.setClassPrice(ctx.principal.organiserId, requestOf(ctx), input),
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
   * Frees a ticket of the organiser's event for transfer or resale (`REQ-TK-6`,
   * `AC-B3.4`): only ever removes a restriction, never adds one (`INV-10`).
   * Removing `cannotResale` from a ticket that cannot be transferred removes both
   * (`REQ-TK-2`). Answers with the ticket's restrictions as the ledger records them.
   */
  removeRestriction: organiserProcedure
    .input(parser<RemoveRestrictionInput>(removeRestrictionInput))
    .mutation(
      ({ ctx, input }): Promise<RestrictionRemoved> =>
        mapped(() =>
          ctx.services.events.removeRestriction(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
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
 * Invitations (`T-021-12`; `F-021` plan §5.6): a guest with no holder account yet
 * is sent a link to Saifu, which links their account and redeems the token.
 */
const invitationsRouter = router({
  /**
   * Creates an invitation to a granted class, at a placement, with an optional
   * guest note kept only in Kippu (`NFR-6`). Its token is returned this once.
   */
  create: organiserProcedure
    .input(parser<CreateInvitationInput>(createInvitationInput))
    .mutation(
      ({ ctx, input }): Promise<CreatedInvitation> =>
        mapped(() =>
          ctx.services.events.createInvitation(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  /** An event's invitations — or one class's — with who redeemed each, oldest first. */
  list: organiserProcedure
    .input(parser<ListInvitationsInput>(listInvitationsInput))
    .query(
      ({ ctx, input }): Promise<readonly Invitation[]> =>
        mapped(() => ctx.services.events.listInvitations(ctx.principal.organiserId, input)),
    ),
  /**
   * Saifu redeems a token for the linked holder account: the class's ticket is
   * issued to it, once. A refusal carries an {@link InvitationRefusal} in
   * `error.data.reason`, beside its transport code and any §10 code:
   * `unknown-invitation` (`NOT_FOUND`), `already-redeemed` and `seat-held`
   * (`CONFLICT`), `seat-taken` (`CONFLICT`, `ERR-TicketIdExists`), `sold-out`
   * (`ERR-CapacityExceeded`) and `class-sold-out` (`ERR-ClassQuotaExceeded`).
   */
  redeem: holderProcedure
    .input(parser<RedeemInvitationInput>(redeemInvitationInput))
    .mutation(
      ({ ctx, input }): Promise<RedeemedInvitation> =>
        mapped(() =>
          ctx.services.events.redeemInvitation(ctx.principal.account, requestOf(ctx), input),
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
  /**
   * Sets the event's sale asset, `COPM/2` or `DUSD/6`. Refused with `CONFLICT`
   * once the event has had a hold or a sale (`F-021` plan, "Prices").
   */
  setSaleAsset: organiserProcedure
    .input(parser<SetSaleAssetInput>(setSaleAssetInput))
    .mutation(
      ({ ctx, input }): Promise<EventSaleAsset> =>
        mapped(() =>
          ctx.services.events.setSaleAsset(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  /**
   * Seals the event (`US-A4`): its sales close and every hold is released first
   * (`REQ-HD-4`), then `Sealed` is submitted; issuance fails thereafter
   * (`ERR-EventSealed`). A ledger refusal — `ERR-InvalidTransition` — reopens sales.
   */
  seal: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .mutation(
      ({ ctx, input }): Promise<StatusChanged> =>
        mapped(() => ctx.services.events.seal(ctx.principal.organiserId, requestOf(ctx), input)),
    ),
  /**
   * Cancels the event (`US-A5`): sales close and holds are released first, then
   * `Cancelled` is submitted, then a refund entitlement is recorded per purchased
   * ticket (`AC-A5.5`). Calling it again on a cancelled event records any refund
   * entitlements still missing, with `cursor` `null`.
   */
  cancel: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .mutation(
      ({ ctx, input }): Promise<StatusChanged> =>
        mapped(() => ctx.services.events.cancel(ctx.principal.organiserId, requestOf(ctx), input)),
    ),
  /**
   * Finishes the event now (`REQ-EV-12`): nothing of it changes on the ledger
   * afterwards (`INV-16`). An event still `Active` has its sales closed first.
   */
  finish: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .mutation(
      ({ ctx, input }): Promise<StatusChanged> =>
        mapped(() => ctx.services.events.finish(ctx.principal.organiserId, requestOf(ctx), input)),
    ),
  /**
   * Schedules the event's `Finished` at a future time, replacing any schedule that
   * has not run. Kippu notices the organiser 24 hours before (`noticedAt`), then
   * finishes the event itself (`REQ-EV-12`). Off unless set.
   */
  scheduleFinish: organiserProcedure
    .input(parser<ScheduleFinishInput>(scheduleFinishInput))
    .mutation(
      ({ ctx, input }): Promise<FinishSchedule> =>
        mapped(() =>
          ctx.services.events.scheduleFinish(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  /** Cancels the event's scheduled `Finished`, until it runs (`CONFLICT` after). */
  cancelScheduledFinish: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .mutation(
      ({ ctx, input }): Promise<FinishSchedule> =>
        mapped(() =>
          ctx.services.events.cancelScheduledFinish(
            ctx.principal.organiserId,
            requestOf(ctx),
            input,
          ),
        ),
    ),
  /** The event's scheduled `Finished`, with its notice; `null` when none was set. */
  finishSchedule: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .query(
      ({ ctx, input }): Promise<FinishSchedule | null> =>
        mapped(() => ctx.services.events.finishSchedule(ctx.principal.organiserId, input)),
    ),
  /**
   * Decreases the event's capacity (`US-A6`): down to the tickets issued plus
   * outstanding holds, never below (`ERR-CapacityBelowIssuance`, with
   * `error.data.reason` `held` when the holds make the difference; `REQ-HD-4`).
   * An increase is refused with `ERR-CapacityProofRequired`: it needs an approved
   * capacity proof (`capacityProofs.request`). The ledger's verdict — `ERR-EventSealed`, say — is passed on.
   */
  decreaseCapacity: organiserProcedure
    .input(parser<DecreaseCapacityInput>(decreaseCapacityInput))
    .mutation(
      ({ ctx, input }): Promise<CapacityChanged> =>
        mapped(() =>
          ctx.services.events.decreaseCapacity(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  /**
   * Capacity increases (`T-021-08`): a request with an artefact, reviewed by Kippu
   * operations. Nothing reaches the ledger until a reviewer approves it.
   */
  capacityProofs: organiserCapacityProofsRouter,
  /**
   * The event's pass window, in milliseconds, with the bounds it can be set within
   * (`NFR-5`). 60 seconds until the organiser sets one.
   */
  passWindow: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .query(
      ({ ctx, input }): Promise<EventPassWindow> =>
        mapped(() => ctx.services.events.passWindow(ctx.principal.organiserId, input)),
    ),
  /**
   * Sets the event's pass window: between 10 seconds and the ledger's maximum pass
   * window, or `BAD_REQUEST`. A Kippu setting, not a ledger fact.
   */
  setPassWindow: organiserProcedure
    .input(parser<SetPassWindowInput>(setPassWindowInput))
    .mutation(
      ({ ctx, input }): Promise<EventPassWindow> =>
        mapped(() =>
          ctx.services.events.setPassWindow(ctx.principal.organiserId, requestOf(ctx), input),
        ),
    ),
  /** The event's sale asset, and whether it is fixed. */
  saleAsset: organiserProcedure
    .input(parser<EventInput>(eventInput))
    .query(
      ({ ctx, input }): Promise<EventSaleAsset> =>
        mapped(() => ctx.services.events.saleAsset(ctx.principal.organiserId, input)),
    ),
  zones: zonesRouter,
  classes: classesRouter,
  tickets: ticketsRouter,
  invitations: invitationsRouter,
});
