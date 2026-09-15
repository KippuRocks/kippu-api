import { classLocator, METADATA_ORIGIN } from "@kippu/metadata-schema";
import type { AccountId, Cursor, EventId, Ticket } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest } from "../authority/errors.js";
import { defaultPassWindow } from "../events/pass-window.js";
import { ledgerLimits } from "../ledger/rules.js";
import type { MetadataStorage } from "../metadata/storage.js";
import { type AdmissionReports, createAdmissionReports } from "../operators/reports.js";
import type { Store } from "../store/store.js";
import { matchAdmissionFlags } from "./admission-flags.js";
import type { CopyFreshness, Freshness } from "./freshness.js";
import type {
  EventView,
  HoldingView,
  PassWindowView,
  ReadFreshness,
  ReadJson,
  Reads,
  TicketView,
} from "./ports.js";
import {
  createDerivedQueries,
  type DerivedQueries,
  type EventPosition,
  type Projected,
  type ProjectedEvent,
} from "./queries.js";

/** A page token: the position of the last event on the page before, `<created>.<EventId>`. */
const PAGE = /^(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})$/;

function pageOf(position: EventPosition): string {
  return `${position.created}.${position.id}`;
}

function positionOf(page: string): EventPosition {
  const match = PAGE.exec(page);
  const created = match === null ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isSafeInteger(created)) {
    throw new RefusedRequest("the page token is not one this index issued");
  }
  return { created, id: match[2] as EventId };
}

/** The longest a client may ask `waitFor` to wait, in ms. */
export const MAX_WAIT_MS = 10_000;

export interface ReadsOptions {
  readonly store: Store;
  readonly freshness: Pick<Freshness, "waitFor" | "current">;
  /** Where Kippu-hosted documents are read from (`F-026`). */
  readonly storage: Pick<MetadataStorage, "get">;
  readonly authority: Pick<OrganiserAuthority, "account">;
  /** The public origin Kippu serves metadata from (`AD-22`); defaults to `https://meta.kippu.rocks`. */
  readonly publicUrl?: string;
  readonly queries?: DerivedQueries;
  /**
   * The ledger's maximum pass window, in ms (`ledgerLimits`), which caps the
   * default window. Defaults to ledger-rules' own maximum.
   */
  readonly maxPassWindow?: number;
  /**
   * How long after `notAfter` the ledger may still record a pass, in ms
   * (`ledgerLimits`), for reconciling failed submissions. Defaults to ledger-rules'.
   */
  readonly maxRecordingLag?: number;
  /** Admission reports from gates (`F-024`), for flags; defaults to the store's. */
  readonly admissionReports?: Pick<AdmissionReports, "list">;
}

type Document = { readonly [field: string]: ReadJson };

async function text(body: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const freshnessOf = (copy: CopyFreshness): ReadFreshness => ({
  cursor: copy.cursor,
  records: copy.records,
  lastRecordedAt: copy.lastRecordedAt,
});

/**
 * The read routers' services (`F-025` plan §2): ledger facts from the derived
 * copy, never the ledger (`NFR-11`), each joined with the public document its
 * metadata locator names (`AC-A3.2`). A ticket is also joined with Kippu's own
 * definition of its class, so the class is legible through Kippu before any
 * document is written (`AC-B2.6`, `F-025` plan §7a).
 *
 * A document is read from Kippu's own metadata storage, and only for a locator
 * under Kippu's metadata origin: a locator elsewhere is returned, never fetched.
 * A missing or unreadable document leaves `metadata` `null`, and the ledger
 * facts stand on their own (`REQ-MD-2`).
 */
export function createReads(options: ReadsOptions): Reads {
  const { store, freshness, storage, authority } = options;
  const origin = new URL(options.publicUrl ?? METADATA_ORIGIN).origin;
  const queries = options.queries ?? createDerivedQueries(store);
  const limits = {
    maxPassWindow: options.maxPassWindow ?? ledgerLimits().maxPassWindow,
    maxRecordingLag: options.maxRecordingLag ?? ledgerLimits().maxRecordingLag,
  };
  const defaultWindow = defaultPassWindow(limits.maxPassWindow);
  const admissionReports = options.admissionReports ?? createAdmissionReports({ store });

  const document = async (locator: string | null): Promise<Document | null> => {
    if (locator === null) return null;
    let url: URL;
    try {
      url = new URL(locator);
    } catch {
      return null;
    }
    if (url.origin !== origin || url.search !== "" || url.hash !== "") return null;
    const object = await storage.get(url.pathname.slice(1));
    if (object === null) return null;
    try {
      const parsed: unknown = JSON.parse(await text(object.body));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Document)
        : null;
    } catch {
      return null;
    }
  };

  const passWindow = async (event: string): Promise<PassWindowView> => {
    const row = (
      await store.query<{ window_ms: number }>(
        "SELECT window_ms FROM event_pass_windows WHERE event = $1",
        [event],
      )
    ).rows[0];
    return row === undefined
      ? { windowMs: defaultWindow, isDefault: true }
      : { windowMs: row.window_ms, isDefault: false };
  };

  const eventView = async (event: ProjectedEvent): Promise<EventView> => ({
    ...event.value,
    zones: event.value.zones.map(({ id, kind }) => ({ id, kind })),
    metadataLocator: event.metadataLocator,
    metadata: await document(event.metadataLocator),
    passWindow: await passWindow(event.value.id),
    sequence: event.sequence,
    authoritative: false,
  });

  /** Kippu's own definition of a ticket's class: defined for the ticket's event, by that id. */
  const kippuClass = async (ticket: Ticket): Promise<{ readonly name: string } | null> => {
    const found = await store.query<{ name: string }>(
      "SELECT name FROM ticket_classes WHERE id = $1 AND event = $2",
      [ticket.class, ticket.event],
    );
    const row = found.rows[0];
    return row === undefined ? null : { name: row.name };
  };

  const ticketView = async (ticket: Projected<Ticket>): Promise<TicketView> => {
    const locator = classLocator(ticket.value.class, origin);
    return {
      ...ticket.value,
      kippuClass: await kippuClass(ticket.value),
      classMetadataLocator: locator,
      classMetadata: await document(locator),
      sequence: ticket.sequence,
      authoritative: false,
    };
  };

  return {
    async event(id) {
      const read = await queries.event(id as EventId);
      return {
        event: read.result === null ? null : await eventView(read.result),
        freshness: freshnessOf(read.freshness),
      };
    },

    async eventsOnSale(limit, page) {
      const after = page === null ? null : positionOf(page);
      // One more than asked for, to know whether another page follows.
      const read = await queries.eventsOnSale(limit + 1, after);
      const shown = read.result.slice(0, limit);
      const last = shown.at(-1);
      return {
        events: await Promise.all(shown.map(({ event }) => eventView(event))),
        nextPage: read.result.length > limit && last !== undefined ? pageOf(last.position) : null,
        freshness: freshnessOf(read.freshness),
      };
    },

    async organiserEvents(organiserId) {
      const account = await authority.account(organiserId);
      if (account === null) {
        return { events: [], freshness: freshnessOf(await freshness.current()) };
      }
      const read = await queries.eventsOwnedBy(account);
      return {
        events: await Promise.all(read.result.map(eventView)),
        freshness: freshnessOf(read.freshness),
      };
    },

    async admissionFlags(organiserId, event) {
      const matched = await matchAdmissionFlags(
        admissionReports,
        queries,
        () => freshness.current(),
        limits,
        organiserId,
        event,
      );
      return { flags: matched.flags, freshness: freshnessOf(matched.freshness) };
    },

    async holdings(account) {
      const read = await queries.holdings(account as AccountId);
      const events = new Map<string, Promise<EventView | null>>();
      const eventOf = (id: EventId) => {
        let found = events.get(id);
        if (found === undefined) {
          found = queries
            .event(id)
            .then((event) => (event.result === null ? null : eventView(event.result)));
          events.set(id, found);
        }
        return found;
      };
      const holdings: HoldingView[] = await Promise.all(
        read.result.map(async (ticket) => ({
          ticket: await ticketView(ticket),
          event: await eventOf(ticket.value.event),
        })),
      );
      return { holdings, freshness: freshnessOf(read.freshness) };
    },

    async waitFor(cursor, timeout) {
      const reached = await freshness.waitFor(cursor as Cursor, Math.min(timeout, MAX_WAIT_MS));
      return { reached, freshness: freshnessOf(await freshness.current()) };
    },
  };
}
