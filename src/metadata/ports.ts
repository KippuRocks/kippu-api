/**
 * Organisers' editing of public metadata documents (`F-026` plan §5.4, `US-A3`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippu/api`: it may import nothing at runtime. Identifiers cross it as
 * lower-case hex strings, and documents as plain JSON.
 */

/** A JSON value, as a metadata document holds it. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [field: string]: JsonValue };

/** A metadata document: a JSON object that declares its schema in `$schema` (`REQ-MD-4`). */
export type MetadataDocument = { readonly [field: string]: JsonValue };

/** An event's document to write. */
export interface PutEventDocumentInput {
  /** The `EventId`: 64 lower-case hex characters. */
  readonly event: string;
  /**
   * The whole document, conforming to the event schema it declares
   * (`https://meta.kippu.rocks/v0/schemas/event/1.0.json`), with `eventId` the event's.
   */
  readonly document: MetadataDocument;
}

/** A ticket class's document to write. */
export interface PutClassDocumentInput {
  /** The `EventId` of the class's event. */
  readonly event: string;
  /** The `ClassId`: 64 lower-case hex characters. */
  readonly class: string;
  /**
   * The whole document, conforming to the class schema it declares
   * (`https://meta.kippu.rocks/v0/schemas/class/1.0.json`), with `classId` and
   * `eventId` the class's.
   */
  readonly document: MetadataDocument;
}

/** A document written. */
export interface WrittenDocument {
  /** The stable URL the document is publicly served at (`REQ-MD-1`). Unchanged by every edit. */
  readonly locator: string;
  /** The stored object's entity tag, as HTTP carries it. */
  readonly etag: string;
}

/**
 * What the metadata router reaches. An edit writes a document and nothing
 * else: no ledger write occurs (`AC-A3.1`). A document that does not conform to
 * its schema is refused with `RefusedRequest`; an event the organiser does not
 * own, with `SpecCodeError`.
 */
export interface Metadata {
  /** Writes an event's document at its locator, replacing the previous version. */
  putEventDocument(organiserId: string, input: PutEventDocumentInput): Promise<WrittenDocument>;
  /** Writes a ticket class's document at its derived locator, replacing the previous version. */
  putClassDocument(organiserId: string, input: PutClassDocumentInput): Promise<WrittenDocument>;
}
