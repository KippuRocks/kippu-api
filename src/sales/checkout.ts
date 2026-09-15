import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { hashSecret } from "../auth/service.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import type { Classes } from "../classes/classes.js";
import type { PlacementInput } from "../events/ports.js";
import type { Zones } from "../events/zones.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import type { Holds } from "./holds.js";
import { eventOnSale } from "./on-sale.js";
import {
  type Checkout,
  type CheckoutAccount,
  CheckoutError,
  type HandoffLink,
  type HoldStatus,
  type Sales,
} from "./ports.js";

/** Bytes of randomness in a checkout token. */
export const CHECKOUT_TOKEN_BYTES = 32;

/** How long a checkout with no hold lives (`F-022` plan §5.1, as ruled in `M2`). */
export const CHECKOUT_LIFETIME_MS = 60 * 60 * 1000;

/** Digits in a pairing code. */
export const PAIRING_CODE_DIGITS = 6;

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
  readonly token_hash: Buffer;
  readonly handoff_token_hash: Buffer;
  readonly handoff_generation: number;
  readonly event: string;
  readonly zone: string;
  readonly class_id: string;
  readonly position: string | null;
  readonly holder_account: string | null;
  readonly link_confirmed_at: Date | null;
  readonly created_at: Date;
  readonly hold_status: HoldStatus | null;
  readonly hold_expires_at: Date | null;
  readonly hold_extended_at: Date | null;
}

const SELECT_CHECKOUT = `
  SELECT c.id, c.token_hash, c.handoff_token_hash, c.handoff_generation, c.event, c.zone,
         c.class_id, c.position, c.holder_account, c.link_confirmed_at, c.created_at,
         h.status AS hold_status, h.expires_at AS hold_expires_at,
         h.extended_at AS hold_extended_at
  FROM checkout_sessions c LEFT JOIN holds h ON h.checkout_id = c.id`;

/**
 * The handoff token of a checkout's `generation`: derived from the page's token,
 * so a page that holds its token can always show the handoff, and a handoff
 * token reveals nothing of the page's.
 */
export function handoffTokenOf(token: string, generation: number): string {
  return createHmac("sha256", token)
    .update(`kippu/checkout/handoff/${generation}`)
    .digest("base64url");
}

/**
 * The pairing code Saifu and the checkout page both show for a link (`F-022`
 * plan §5.1, handoff pairing): derived from the handoff and the linked account,
 * keyed by the checkout's secret, so nobody can compute it before linking.
 */
function pairingCodeOf(
  row: Pick<CheckoutRow, "token_hash" | "handoff_token_hash">,
  account: string,
) {
  const digest = createHmac("sha256", row.token_hash)
    .update(`kippu/checkout/pairing/${row.handoff_token_hash.toString("hex")}/${account}`)
    .digest();
  return String(digest.readUInt32BE(0) % 10 ** PAIRING_CODE_DIGITS).padStart(
    PAIRING_CODE_DIGITS,
    "0",
  );
}

/**
 * Checkout sessions (`T-022-02`, `T-022-11`; `F-022` plan §5.1, steps 1–3).
 *
 * A checkout is begun for what the buyer picked, and needs a holder account
 * before it proceeds: a ticket is issued to an account (`INV-2`), and only Saifu
 * provisions and holds holder credentials (`REQ-CL-2`, `AD-19` A). A buyer who
 * begins checkout with a holder session is linked at once. Anyone else — Ichiba's
 * anonymous visitor (`REQ-MP-7`) — gets a Saifu handoff with a token of its own.
 * Saifu links the holder's account with it, and both sides show a pairing code;
 * the buyer confirms the match on the checkout page, with the page's token,
 * before a hold is placed (`T-022-03`). A checkout with no hold expires after an
 * hour.
 */
export function createCheckouts(options: CheckoutsOptions): Omit<Sales, "inventory"> {
  const { store, ledger, classes, zones, holds, now = () => new Date() } = options;
  const random = options.randomBytes ?? ((length: number) => randomBytes(length));

  const expiresAtOf = (row: CheckoutRow): Date | null =>
    row.hold_status === null ? new Date(row.created_at.getTime() + CHECKOUT_LIFETIME_MS) : null;

  const accountOf = (row: CheckoutRow, token: string): CheckoutAccount => {
    if (row.holder_account === null) {
      return {
        state: "handoff",
        handoff: { handoffToken: handoffTokenOf(token, row.handoff_generation) },
      };
    }
    if (row.link_confirmed_at === null) {
      return { state: "pairing", pairingCode: pairingCodeOf(row, row.holder_account) };
    }
    return { state: "linked", holder: row.holder_account };
  };

  const checkoutOf = (row: CheckoutRow, token: string): Checkout => {
    const placement: PlacementInput =
      row.position === null ? { kind: "Unseated" } : { kind: "Seated", position: row.position };
    const holdExpiresAt = row.hold_expires_at;
    const expiresAt = expiresAtOf(row);
    return {
      event: row.event,
      zone: row.zone,
      class: row.class_id,
      placement,
      account: accountOf(row, token),
      hold:
        row.hold_status === null || holdExpiresAt === null
          ? null
          : {
              // An outstanding hold past its lifetime has lapsed, recorded or not.
              status:
                row.hold_status === "outstanding" && holdExpiresAt <= now()
                  ? "lapsed"
                  : row.hold_status,
              expiresAt: holdExpiresAt.toISOString(),
              extended: row.hold_extended_at !== null,
            },
      createdAt: row.created_at.toISOString(),
      expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
    };
  };

  /** The live checkout a column's hash names; an expired one is gone. */
  const findBy = async (column: "token_hash" | "handoff_token_hash", secret: string) => {
    const result = await store.query<CheckoutRow>(`${SELECT_CHECKOUT} WHERE c.${column} = $1`, [
      hashSecret(secret),
    ]);
    const row = result.rows[0];
    const expiresAt = row === undefined ? null : expiresAtOf(row);
    if (row === undefined || (expiresAt !== null && expiresAt <= now())) {
      throw new CheckoutError(
        "unknown-checkout",
        row === undefined ? "no checkout has this token" : "the checkout expired",
      );
    }
    return row;
  };

  const find = (token: string) => findBy("token_hash", token);

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
      // A buyer with their own holder session needs no handoff, nor pairing.
      const holder = principal.kind === "holder" ? principal : null;
      const at = now();
      await store.query(
        `INSERT INTO checkout_sessions
           (id, token_hash, handoff_token_hash, event, zone, class_id, position, holder_account,
            created_request_id, created_principal_kind, created_at, linked_session_id,
            linked_request_id, linked_at, link_confirmed_at, link_confirmed_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $13)`,
        [
          randomUUID(),
          hashSecret(token),
          hashSecret(handoffTokenOf(token, 0)),
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

    async linkCheckout(request, handoffToken): Promise<HandoffLink> {
      const { principal } = request;
      if (principal.kind !== "holder") {
        throw new RefusedRequest("only a holder's session links an account to a checkout");
      }
      const found = await findBy("handoff_token_hash", handoffToken);
      await store.query(
        `UPDATE checkout_sessions
         SET holder_account = $2, linked_session_id = $3, linked_request_id = $4, linked_at = $5
         WHERE id = $1 AND handoff_generation = $6 AND holder_account IS NULL`,
        [
          found.id,
          principal.account,
          principal.sessionId,
          request.requestId,
          now(),
          found.handoff_generation,
        ],
      );
      const row = await findBy("handoff_token_hash", handoffToken);
      if (row.holder_account !== principal.account) {
        throw new CheckoutError(
          "linked-to-another-account",
          "the checkout is already linked to another holder account",
        );
      }
      return {
        event: row.event,
        zone: row.zone,
        class: row.class_id,
        placement:
          row.position === null ? { kind: "Unseated" } : { kind: "Seated", position: row.position },
        pairingCode: pairingCodeOf(row, principal.account),
      };
    },

    async confirmLink(request, token, pairingCode) {
      const row = await find(token);
      if (row.holder_account === null) {
        throw new CheckoutError("not-pairing", "no account is linked to the checkout yet");
      }
      if (pairingCode !== pairingCodeOf(row, row.holder_account)) {
        throw new CheckoutError("pairing-code-mismatch", "the pairing code is not the checkout's");
      }
      if (row.link_confirmed_at === null) {
        await store.query(
          `UPDATE checkout_sessions SET link_confirmed_at = $2, link_confirmed_request_id = $3
           WHERE id = $1 AND holder_account = $4 AND link_confirmed_at IS NULL`,
          [row.id, now(), request.requestId, row.holder_account],
        );
      }
      return checkoutOf(await find(token), token);
    },

    async discardLink(_request, token) {
      const row = await find(token);
      if (row.holder_account === null || row.link_confirmed_at !== null) {
        throw new CheckoutError("not-pairing", "the checkout has no unconfirmed link to discard");
      }
      const generation = row.handoff_generation + 1;
      await store.query(
        `UPDATE checkout_sessions
         SET holder_account = NULL, linked_session_id = NULL, linked_request_id = NULL,
             linked_at = NULL, handoff_generation = $2, handoff_token_hash = $3
         WHERE id = $1 AND handoff_generation = $4 AND link_confirmed_at IS NULL`,
        [row.id, generation, hashSecret(handoffTokenOf(token, generation)), row.handoff_generation],
      );
      return checkoutOf(await find(token), token);
    },

    async hold(request, token) {
      const row = await find(token);
      if (row.holder_account === null) {
        throw new CheckoutError(
          "account-required",
          "the checkout has no holder account yet: hand off to Saifu first",
        );
      }
      if (row.link_confirmed_at === null) {
        throw new CheckoutError(
          "link-unconfirmed",
          "confirm on the checkout page that Saifu shows the same pairing code first",
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
