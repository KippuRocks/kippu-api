import {
  classLocator,
  eventLocator,
  METADATA_ORIGIN,
  SCHEMA_BASE_URL,
} from "@kippu/metadata-schema";
import type { EventId } from "@ticketto/sdk";
import type { OrganiserAuthority } from "../authority/authority.js";
import { RefusedRequest, SpecCodeError } from "../authority/errors.js";
import { ownedEvent } from "../events/ownership.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import type { Metadata, MetadataDocument, WrittenDocument } from "./ports.js";
import type { MetadataStorage } from "./storage.js";
import { createDocumentValidator, type DocumentValidator } from "./validation.js";

/** The media type documents are stored and served with. */
export const DOCUMENT_CONTENT_TYPE = "application/json";

/** The largest document accepted, in bytes of its JSON encoding. */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

export interface MetadataDocumentsOptions {
  readonly store: Store;
  readonly storage: MetadataStorage;
  /** Read only: who owns an event is a ledger fact (`REQ-IX-1`). Nothing here writes to the ledger. */
  readonly ledger: Pick<KippuTicketto, "getEvent">;
  readonly authority: Pick<OrganiserAuthority, "account">;
  /** The public origin locators name (`AD-22`); defaults to `https://meta.kippu.rocks`. */
  readonly publicUrl?: string;
  readonly validator?: DocumentValidator;
}

/** The object key a locator is served from: its path. */
function keyOf(locator: string): string {
  return new URL(locator).pathname.slice(1);
}

/** The document's declared schema, provided it is a published schema for `kind` documents. */
function declaredSchema(document: MetadataDocument, kind: "event" | "class"): string {
  const declared = document.$schema;
  if (typeof declared !== "string" || !declared.startsWith(`${SCHEMA_BASE_URL}${kind}/`)) {
    throw new RefusedRequest(`the document must declare a ${kind} schema in $schema`);
  }
  return declared;
}

/**
 * Organisers' editing of their events' and classes' public documents
 * (`US-A3`, `F-026` plan §5.4).
 *
 * An edit validates the whole document against the schema it declares, and
 * stores it at the document's locator, replacing what was there. That is all
 * it does: no SDK command exists in this path, so no ledger write occurs
 * (`AC-A3.1`), and the locator on the ledger never changes (`REQ-MD-1`).
 */
export function createMetadataDocuments(options: MetadataDocumentsOptions): Metadata {
  const { store, storage, ledger, authority } = options;
  const origin = options.publicUrl ?? METADATA_ORIGIN;
  const validator = options.validator ?? createDocumentValidator();

  const write = async (
    locator: string,
    schemaId: string,
    document: MetadataDocument,
  ): Promise<WrittenDocument> => {
    const validation = validator.validate(schemaId, document);
    if (!validation.valid) {
      throw new RefusedRequest(
        `the document does not conform to ${schemaId}: ${validation.errors.join("; ")}`,
      );
    }
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      throw new RefusedRequest(`a document is at most ${MAX_DOCUMENT_BYTES} bytes`);
    }
    const { etag } = await storage.put(keyOf(locator), bytes, {
      contentType: DOCUMENT_CONTENT_TYPE,
    });
    return { locator, etag };
  };

  return {
    async putEventDocument(organiserId, { event, document }) {
      await ownedEvent(ledger, authority, organiserId, event as EventId);
      const schemaId = declaredSchema(document, "event");
      if (document.eventId !== event) {
        throw new RefusedRequest("the document's eventId must be the event's");
      }
      // Where the ledger points: the locator the event was created with.
      const link = await store.query<{ metadata_locator: string | null }>(
        "SELECT metadata_locator FROM organiser_events WHERE event = $1",
        [event],
      );
      const locator = link.rows[0]?.metadata_locator ?? eventLocator(event, origin);
      return write(locator, schemaId, document);
    },

    async putClassDocument(organiserId, { event, class: classId, document }) {
      await ownedEvent(ledger, authority, organiserId, event as EventId);
      const found = await store.query("SELECT 1 FROM ticket_classes WHERE id = $1 AND event = $2", [
        classId,
        event,
      ]);
      if ((found.rowCount ?? 0) === 0) {
        throw new SpecCodeError("ERR-UnknownClass", "the event has no class with that id");
      }
      const schemaId = declaredSchema(document, "class");
      if (document.classId !== classId || document.eventId !== event) {
        throw new RefusedRequest("the document's classId and eventId must be the class's");
      }
      return write(classLocator(classId, origin), schemaId, document);
    },
  };
}
