import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { toTRPCError } from "../trpc/errors.js";
import { holderProcedure, publicProcedure, router } from "../trpc/trpc.js";
import {
  type BeginCheckoutInput,
  type BegunCheckout,
  type Checkout,
  CheckoutError,
  type CheckoutFailure,
  type CheckoutTokenInput,
  type ConfirmLinkInput,
  type HandoffLink,
  type HandoffTokenInput,
  type HoldOutcome,
  type SaleInventory,
  type SaleInventoryInput,
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

const TRANSPORT_CODE: Record<CheckoutFailure, TRPCError["code"]> = {
  "unknown-checkout": "NOT_FOUND",
  "linked-to-another-account": "CONFLICT",
  "account-required": "PRECONDITION_FAILED",
  "hold-ended": "CONFLICT",
  "link-unconfirmed": "PRECONDITION_FAILED",
  "not-pairing": "PRECONDITION_FAILED",
  "pairing-code-mismatch": "CONFLICT",
};

/**
 * A §10 refusal reaches the client with its code in `error.data.errorCode`; a
 * refusal §10 has no code for, with a transport code and its message.
 */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpecCodeError) {
      throw toTRPCError(error);
    }
    if (error instanceof RefusedRequest) {
      throw new TRPCError({ code: error.transport, message: error.message });
    }
    if (error instanceof CheckoutError) {
      throw new TRPCError({ code: TRANSPORT_CODE[error.failure], message: error.message });
    }
    throw error;
  }
}

const id32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex characters");

const designation = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.isWellFormed(), "expected well-formed Unicode");

const beginCheckoutInput = z
  .object({
    event: id32,
    zone: id32,
    class: id32,
    placement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("Seated"), position: designation }).strict(),
      z.object({ kind: z.literal("Unseated") }).strict(),
    ]),
  })
  .strict();

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected a checkout token");

const tokenInput = z.object({ token }).strict();

const handoffTokenInput = z.object({ handoffToken: token }).strict();

const confirmLinkInput = z
  .object({ token, pairingCode: z.string().regex(/^[0-9]{6}$/, "expected a 6-digit code") })
  .strict();

/**
 * Checkout sessions (`F-022` plan §5.1). Ichiba begins a checkout for what the
 * buyer picked. It proceeds once a holder account is linked and the link
 * confirmed (`AC-B4.1`): at once when the caller has a holder session; otherwise
 * through a Saifu handoff. Ichiba passes the handoff token to Saifu, which links
 * the holder's account with `link` and shows a pairing code; Ichiba reads the
 * checkout with `get`, shows the same code, and the buyer confirms the match
 * with `confirmLink` — or discards the link with `discardLink`, which replaces
 * the handoff token (`AD-19` A, handoff pairing). A checkout with no hold
 * expires an hour after it began, and is then `NOT_FOUND`.
 */
const checkoutRouter = router({
  /**
   * Begins a checkout. Refused with `ERR-EventNotFound`, `ERR-EventSealed`,
   * `ERR-EventCancelled`, `ERR-EventFinished`, `ERR-UnknownClass`,
   * `ERR-UnknownZone` or `ERR-ZoneKindMismatch`; and as `BAD_REQUEST` for a class
   * that is not `Purchased`, or a seat that is not one of the zone's canonical
   * positions. The token is shown only here.
   */
  begin: publicProcedure
    .input(parser<BeginCheckoutInput>(beginCheckoutInput))
    .mutation(
      ({ ctx, input }): Promise<BegunCheckout> =>
        mapped(() =>
          ctx.services.sales.beginCheckout(
            { requestId: ctx.requestId, principal: ctx.principal },
            input,
          ),
        ),
    ),
  /** The checkout a token names; `NOT_FOUND` for none. */
  get: publicProcedure
    .input(parser<CheckoutTokenInput>(tokenInput))
    .query(
      ({ ctx, input }): Promise<Checkout> => mapped(() => ctx.services.sales.checkout(input.token)),
    ),
  /**
   * Links the signed-in holder's account to the checkout a handoff token hands
   * off — Saifu's half of the handoff — and answers with what is being bought and
   * the pairing code to show. Linking again with the same account changes
   * nothing; a checkout linked to another account is refused with `CONFLICT`.
   * The checkout page's own token links nothing: it is `NOT_FOUND` here.
   */
  link: holderProcedure
    .input(parser<HandoffTokenInput>(handoffTokenInput))
    .mutation(
      ({ ctx, input }): Promise<HandoffLink> =>
        mapped(() =>
          ctx.services.sales.linkCheckout(
            { requestId: ctx.requestId, principal: ctx.principal },
            input.handoffToken,
          ),
        ),
    ),
  /**
   * The buyer confirms, on the checkout page, that Saifu shows the same pairing
   * code. `CONFLICT` for another code; `PRECONDITION_FAILED` with no link.
   * Confirming a confirmed link again changes nothing.
   */
  confirmLink: publicProcedure
    .input(parser<ConfirmLinkInput>(confirmLinkInput))
    .mutation(
      ({ ctx, input }): Promise<Checkout> =>
        mapped(() =>
          ctx.services.sales.confirmLink(
            { requestId: ctx.requestId, principal: ctx.principal },
            input.token,
            input.pairingCode,
          ),
        ),
    ),
  /**
   * The buyer discards an unconfirmed link — the codes did not match. The
   * checkout is handed off again, with a new handoff token. `PRECONDITION_FAILED`
   * with no unconfirmed link.
   */
  discardLink: publicProcedure
    .input(parser<CheckoutTokenInput>(tokenInput))
    .mutation(
      ({ ctx, input }): Promise<Checkout> =>
        mapped(() =>
          ctx.services.sales.discardLink(
            { requestId: ctx.requestId, principal: ctx.principal },
            input.token,
          ),
        ),
    ),
  /**
   * Places the checkout's hold, before any payment (`REQ-HD-1`, `REQ-HD-3`). It is
   * counted, in one transaction, against the event's capacity, the class's quota
   * and the seat; when any is exhausted the answer is `refused`, with the reason
   * — `sold-out`, `class-sold-out` or `seat-taken` — for the buyer to see before
   * paying (`AC-B4.4`). A checkout with no holder account, or an unconfirmed
   * link, is `PRECONDITION_FAILED`; one whose hold lapsed or was released is `CONFLICT`.
   * Asking again while the hold is outstanding answers with the same hold.
   */
  hold: publicProcedure
    .input(parser<CheckoutTokenInput>(tokenInput))
    .mutation(
      ({ ctx, input }): Promise<HoldOutcome> =>
        mapped(() =>
          ctx.services.sales.hold(
            { requestId: ctx.requestId, principal: ctx.principal },
            input.token,
          ),
        ),
    ),
});

const inventoryInput = z
  .object({ event: z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lower-case hex characters") })
  .strict();

/** Primary sales (`F-022`). */
export const salesRouter = router({
  checkout: checkoutRouter,
  /**
   * What Ichiba offers of an event, with no session (`REQ-MP-7`): whether it is
   * on sale, how many tickets can still be held — of the event, and of each
   * `Purchased` class — counting outstanding holds (`REQ-HD-3`), and each seated
   * zone's free canonical seats, neither issued nor held (`US-B5`). A display
   * snapshot: the hold decides. `ERR-EventNotFound` for no such event.
   */
  inventory: publicProcedure
    .input(parser<SaleInventoryInput>(inventoryInput))
    .query(
      ({ ctx, input }): Promise<SaleInventory> =>
        mapped(() => ctx.services.sales.inventory(input.event)),
    ),
});
