/**
 * Organisers' editing of public metadata documents (`F-026` plan §5.4, `US-A3`).
 *
 * This module is imported by the tRPC context, whose type is published in
 * `@kippurocks/api`: it may import nothing at runtime. Identifiers cross it as
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

/** The image types an event document may use: raster formats with no active content. */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

/** An image to upload for an event's document (`T-026-06`). */
export interface UploadImageInput {
  /** The `EventId` of the event the image illustrates. */
  readonly event: string;
  readonly mediaType: ImageMediaType;
  /** The image's bytes, in standard base64. At most 2 MiB once decoded. */
  readonly data: string;
}

/** An image stored at the metadata origin. */
export interface UploadedImage {
  /** Where the image is publicly served: the URL a document references it by. */
  readonly url: string;
  readonly mediaType: ImageMediaType;
  /** Its size in bytes. */
  readonly size: number;
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
  /**
   * Stores an image for an event the organiser owns, at the metadata origin, so
   * its document can reference it and stay self-contained (`F-026` plan §5.3). An
   * image of another type, larger than the limit, or whose bytes are not the
   * type declared is refused with `RefusedRequest`. Uploading the same bytes
   * again answers the same URL.
   */
  uploadImage(organiserId: string, input: UploadImageInput): Promise<UploadedImage>;
}
