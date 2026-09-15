import { randomBytes } from "node:crypto";
import type { EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { ownedEvent } from "../events/ownership.js";
import type {
  AttendancePolicy,
  DefineClassInput,
  EventInput,
  EventsRequest,
  SetClassPriceInput,
  TicketClass,
} from "../events/ports.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";

/** Bytes in a `ClassId`: opaque and random (`F-021` plan §5.2; `F-026` plan §5.2). */
export const CLASS_ID_BYTES = 32;

/**
 * Ticket classes: Kippu data, off the ledger (`REQ-TC-2`). An organiser defines
 * any number of classes per event, each configured independently (`REQ-TC-1`).
 */
export interface Classes {
  define(
    organiserId: string,
    request: EventsRequest,
    input: DefineClassInput,
  ): Promise<TicketClass>;
  list(organiserId: string, input: EventInput): Promise<readonly TicketClass[]>;
  /** Sets a `Purchased` class's price, for holds placed from now on (`F-021` plan, "Prices"). */
  setPrice(
    organiserId: string,
    request: EventsRequest,
    input: SetClassPriceInput,
  ): Promise<TicketClass>;
  /** A class defined for `event`, or `null` when `event` has no class with that id. */
  find(event: string, classId: string): Promise<TicketClass | null>;
}

export interface ClassesOptions {
  readonly store: Store;
  readonly authority: Pick<OrganiserAuthority, "account">;
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

interface ClassRow {
  readonly id: string;
  readonly event: string;
  readonly name: string;
  readonly description: string | null;
  readonly provenance: TicketClass["provenance"];
  readonly policy: AttendancePolicy;
  readonly cannot_resale: boolean;
  readonly cannot_transfer: boolean;
  readonly quota: string | null;
  readonly price: string | null;
  readonly created_at: Date;
}

const COLUMNS = `id, event, name, description, provenance, policy, cannot_resale, cannot_transfer,
  quota, price, created_at`;

function classOf(row: ClassRow): TicketClass {
  return {
    id: row.id,
    event: row.event,
    name: row.name,
    description: row.description,
    provenance: row.provenance,
    policy: row.policy,
    restrictions: { cannotResale: row.cannot_resale, cannotTransfer: row.cannot_transfer },
    quota: row.quota === null ? null : Number(row.quota),
    price: row.price === null ? null : Number(row.price),
    createdAt: row.created_at.toISOString(),
  };
}

/** A price: a positive safe integer, in the sale asset's minor units. */
function isPrice(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

/** The policy's own fields only, in a fixed shape, as the ledger will carry it. */
function canonicalPolicy(policy: AttendancePolicy): AttendancePolicy {
  switch (policy.kind) {
    case "Single":
      return { kind: "Single" };
    case "Multiple":
      return { kind: "Multiple", max: policy.max, until: policy.until };
    case "Unlimited":
      return { kind: "Unlimited", until: policy.until };
  }
}

export function createClasses(options: ClassesOptions): Classes {
  const { store, authority, ledger, now = () => new Date() } = options;
  const random = options.randomBytes ?? ((length: number) => randomBytes(length));

  return {
    async define(organiserId, request, input) {
      const { cannotResale, cannotTransfer } = input.restrictions;
      // REQ-TC-3: a purchased class is refused at definition, never at issuance. A paid
      // ticket is always resellable and transferable (REQ-TK-3, INV-12).
      if (input.provenance === "Purchased" && (cannotResale || cannotTransfer)) {
        throw new SpecCodeError(
          "ERR-RestrictionNotPermitted",
          "a class declared Purchased may not declare restrictions",
        );
      }
      // Every Purchased class has a price; a Granted class has none (F-021 plan, "Prices").
      const price = input.price ?? null;
      if (input.provenance === "Purchased" && !isPrice(price)) {
        throw new RefusedRequest(
          "a Purchased class needs a price: a positive integer in the sale asset's minor units",
        );
      }
      if (input.provenance === "Granted" && price !== null) {
        throw new RefusedRequest("a Granted class has no price");
      }
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);

      const id = Buffer.from(random(CLASS_ID_BYTES)).toString("hex");
      const result = await store.query<ClassRow>(
        `INSERT INTO ticket_classes
           (id, event, organiser_id, name, description, provenance, policy, cannot_resale,
            cannot_transfer, quota, created_request_id, created_at, price, price_set_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 CASE WHEN $13::bigint IS NULL THEN NULL ELSE $12::timestamptz END)
         RETURNING ${COLUMNS}`,
        [
          id,
          input.event,
          organiserId,
          input.name,
          input.description,
          input.provenance,
          JSON.stringify(canonicalPolicy(input.policy)),
          // REQ-TK-2: what cannot change hands gratis cannot change hands for money. The
          // class records the restrictions its tickets will carry on the ledger.
          cannotResale || cannotTransfer,
          cannotTransfer,
          input.quota,
          request.requestId,
          now(),
          price,
        ],
      );
      return classOf(result.rows[0] as ClassRow);
    },

    async setPrice(organiserId, _request, input) {
      if (!isPrice(input.price)) {
        throw new RefusedRequest("a price is a positive integer in the sale asset's minor units");
      }
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const updated = await store.query<ClassRow>(
        `UPDATE ticket_classes SET price = $3, price_set_at = $4
         WHERE event = $1 AND id = $2 AND provenance = 'Purchased'
         RETURNING ${COLUMNS}`,
        [input.event, input.class, input.price, now()],
      );
      const row = updated.rows[0];
      if (row !== undefined) return classOf(row);
      const exists = await store.query(
        "SELECT 1 FROM ticket_classes WHERE event = $1 AND id = $2",
        [input.event, input.class],
      );
      if ((exists.rowCount ?? 0) === 0) {
        throw new SpecCodeError("ERR-UnknownClass", "the class is not defined for the event");
      }
      throw new RefusedRequest("a Granted class has no price");
    },

    async list(organiserId, input) {
      await ownedEvent(ledger, authority, organiserId, input.event as EventId);
      const result = await store.query<ClassRow>(
        `SELECT ${COLUMNS} FROM ticket_classes WHERE event = $1 ORDER BY created_at, id`,
        [input.event],
      );
      return result.rows.map(classOf);
    },

    async find(event, classId) {
      const result = await store.query<ClassRow>(
        `SELECT ${COLUMNS} FROM ticket_classes WHERE event = $1 AND id = $2`,
        [event, classId],
      );
      const row = result.rows[0];
      return row === undefined ? null : classOf(row);
    },
  };
}
