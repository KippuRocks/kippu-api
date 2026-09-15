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
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
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

const tokenInput = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected a checkout token") })
  .strict();

/**
 * Checkout sessions (`F-022` plan §5.1). Ichiba begins a checkout for what the
 * buyer picked. It proceeds once a holder account is linked (`AC-B4.1`): at once
 * when the caller has a holder session, and otherwise through a Saifu handoff —
 * Ichiba passes the handoff's token to Saifu, which links the holder's account
 * with `link`, while Ichiba reads the checkout with `get` until it is linked
 * (`AD-19` A).
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
   * Links the signed-in holder's account to the checkout — Saifu's half of the
   * handoff. Linking again with the same account changes nothing; a checkout
   * linked to another account is refused with `CONFLICT`.
   */
  link: holderProcedure
    .input(parser<CheckoutTokenInput>(tokenInput))
    .mutation(
      ({ ctx, input }): Promise<Checkout> =>
        mapped(() =>
          ctx.services.sales.linkCheckout(
            { requestId: ctx.requestId, principal: ctx.principal },
            input.token,
          ),
        ),
    ),
});

/** Primary sales (`F-022`). */
export const salesRouter = router({
  checkout: checkoutRouter,
});
