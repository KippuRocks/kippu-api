import { randomBytes, randomUUID } from "node:crypto";
import { hashSecret } from "../auth/service.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { Classes } from "../classes/classes.js";
import type { PlacementInput } from "../events/ports.js";
import type { Zones } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import type { Holds } from "./holds.js";
import { eventOnSale } from "./on-sale.js";
import { type Checkout, CheckoutError, type HoldStatus, type Sales } from "./ports.js";

/** Bytes of randomness in a checkout token. */
export const CHECKOUT_TOKEN_BYTES = 32;

export interface CheckoutsOptions {
  readonly store: Store;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly classes: Pick<Classes, "find">;
  readonly zones: Pick<Zones, "canonicalPosition">;
  /** Issuance holds (`T-022-03`). */
  readonly holds: Pick<Holds, "place">;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

interface CheckoutRow {
  readonly id: string;
  readonly event: string;
  readonly zone: string;
  readonly class_id: string;
  readonly position: string | null;
  readonly holder_account: string | null;
  readonly created_at: Date;
  readonly hold_status: HoldStatus | null;
  readonly hold_expires_at: Date | null;
  readonly hold_extended_at: Date | null;
}

const SELECT_CHECKOUT = `
  SELECT c.id, c.event, c.zone, c.class_id, c.position, c.holder_account, c.created_at,
         h.status AS hold_status, h.expires_at AS hold_expires_at,
         h.extended_at AS hold_extended_at
  FROM checkout_sessions c LEFT JOIN holds h ON h.checkout_id = c.id
  WHERE c.token_hash = $1`;

/**
 * Checkout sessions (`T-022-02`; `F-022` plan §5.1, steps 1–3).
 *
 * A checkout is begun for what the buyer picked, and needs a holder account
 * before it proceeds: a ticket is issued to an account (`INV-2`), and only Saifu
 * provisions and holds holder credentials (`REQ-CL-2`, `AD-19` A). A buyer who
 * begins checkout with a holder session is linked at once; anyone else — Ichiba's
 * anonymous visitor (`REQ-MP-7`) — gets a Saifu handoff, and the checkout waits
 * until Saifu links an account with the holder's session (`AC-B4.1`). A linked
 * checkout then places its hold (`T-022-03`), before any payment.
 */
export function createCheckouts(options: CheckoutsOptions): Sales {
  const { store, ledger, classes, zones, holds, now = () => new Date() } = options;
  const random = options.randomBytes ?? ((length: number) => randomBytes(length));

  const checkoutOf = (row: CheckoutRow, token: string): Checkout => {
    const placement: PlacementInput =
      row.position === null ? { kind: "Unseated" } : { kind: "Seated", position: row.position };
    const expiresAt = row.hold_expires_at;
    return {
      event: row.event,
      zone: row.zone,
      class: row.class_id,
      placement,
      account:
        row.holder_account === null
          ? { state: "handoff", handoff: { token } }
          : { state: "linked", holder: row.holder_account },
      hold:
        row.hold_status === null || expiresAt === null
          ? null
          : {
              // An outstanding hold past its lifetime has lapsed, recorded or not.
              status:
                row.hold_status === "outstanding" && expiresAt <= now()
                  ? "lapsed"
                  : row.hold_status,
              expiresAt: expiresAt.toISOString(),
              extended: row.hold_extended_at !== null,
            },
      createdAt: row.created_at.toISOString(),
    };
  };

  const find = async (token: string): Promise<CheckoutRow> => {
    const result = await store.query<CheckoutRow>(SELECT_CHECKOUT, [hashSecret(token)]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new CheckoutError("unknown-checkout", "no checkout has this token");
    }
    return row;
  };

  return {
    async beginCheckout(request, input) {
      // The event is on sale: it exists, and is Active (`REQ-EV-8`).
      const event = await eventOnSale(ledger, input.event);

      // The class is defined for the event, and its tickets are sold (`REQ-TC-2`, `REQ-TK-3`).
      const ticketClass = await classes.find(input.event, input.class);
      if (ticketClass === null) {
        throw new SpecCodeError("ERR-UnknownClass", "the class is not defined for the event");
      }
      if (ticketClass.provenance !== "Purchased") {
        throw new RefusedRequest(
          "a Granted class's tickets are issued free by the organiser, never sold at checkout",
        );
      }

      // The placement fits the zone: a seat is one of its canonical positions (`REQ-ID-3`).
      const zone = event.zones.find(({ id }) => id === input.zone);
      if (zone === undefined) {
        throw new SpecCodeError(
          "ERR-UnknownZone",
          `zone ${input.zone} is not defined for the event`,
        );
      }
      if (zone.kind !== input.placement.kind) {
        throw new SpecCodeError(
          "ERR-ZoneKindMismatch",
          `a ${input.placement.kind} placement does not fit a ${zone.kind} zone`,
        );
      }
      let position: string | null = null;
      if (input.placement.kind === "Seated") {
        // The designation as the zone's canonical list has it: the one its ticket's id derives from.
        const canonical = await zones.canonicalPosition(
          input.event,
          input.zone,
          input.placement.position,
        );
        position = Buffer.from(canonical, "hex").toString("utf8");
      }

      const token = Buffer.from(random(CHECKOUT_TOKEN_BYTES)).toString("base64url");
      const { principal } = request;
      const holder = principal.kind === "holder" ? principal : null;
      const at = now();
      await store.query(
        `INSERT INTO checkout_sessions
           (id, token_hash, event, zone, class_id, position, holder_account, created_request_id,
            created_principal_kind, created_at, linked_session_id, linked_request_id, linked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          randomUUID(),
          hashSecret(token),
          input.event,
          input.zone,
          input.class,
          position,
          holder?.account ?? null,
          request.requestId,
          principal.kind,
          at,
          holder?.sessionId ?? null,
          holder === null ? null : request.requestId,
          holder === null ? null : at,
        ],
      );
      return { token, checkout: checkoutOf(await find(token), token) };
    },

    async checkout(token) {
      return checkoutOf(await find(token), token);
    },

    async linkCheckout(request, token) {
      const { principal } = request;
      if (principal.kind !== "holder") {
        throw new RefusedRequest("only a holder's session links an account to a checkout");
      }
      await store.query(
        `UPDATE checkout_sessions
         SET holder_account = $2, linked_session_id = $3, linked_request_id = $4, linked_at = $5
         WHERE token_hash = $1 AND holder_account IS NULL`,
        [hashSecret(token), principal.account, principal.sessionId, request.requestId, now()],
      );
      const row = await find(token);
      if (row.holder_account !== principal.account) {
        throw new CheckoutError(
          "linked-to-another-account",
          "the checkout is already linked to another holder account",
        );
      }
      return checkoutOf(row, token);
    },

    async hold(request, token) {
      const row = await find(token);
      if (row.holder_account === null) {
        throw new CheckoutError(
          "account-required",
          "the checkout has no holder account yet: hand off to Saifu first",
        );
      }
      const refusal = await holds.place(request, {
        checkoutId: row.id,
        event: row.event,
        zone: row.zone,
        classId: row.class_id,
        position: row.position,
      });
      if (refusal !== null) {
        return { outcome: "refused", reason: refusal };
      }
      return { outcome: "held", checkout: checkoutOf(await find(token), token) };
    },
  };
}
