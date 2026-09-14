/**
 * Self-containment of metadata documents, for relocation (`REQ-MD-1`, `F-026`
 * plan §5.3).
 *
 * `REQ-MD-1` allows locators to be relocated to a longer-lived store once Kippu
 * no longer operates. That is a move of files only if the files depend on
 * nothing else: so a document references nothing on Kippu's APIs, and every URL
 * it holds — images, seat maps, its own `$schema` — is served from the same
 * storage, under the metadata public origin. A relocation then rewrites one
 * origin and moves the objects under it.
 *
 * A URL here is a string value that is, in its entirety, an absolute `http` or
 * `https` URL. Prose that mentions a web address is not a reference a
 * relocation must follow.
 */
import type { JsonValue } from "./ports.js";
import type { MetadataStorage } from "./storage.js";

/** Where document objects live: an event's, and a class's (`F-026` plan §5.1). */
export const DOCUMENT_PREFIXES: readonly string[] = ["v0/events/", "v0/classes/"];

export interface ForeignReference {
  /** JSON Pointer, within the document, to the value. */
  readonly pointer: string;
  readonly url: string;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function absoluteWebUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Every URL in `document` not served from `publicUrl`'s origin — a Kippu API
 * URL among them — with where it appears.
 */
export function foreignReferences(document: JsonValue, publicUrl: string): ForeignReference[] {
  const origin = new URL(publicUrl).origin;
  const found: ForeignReference[] = [];
  const walk = (value: JsonValue, pointer: string): void => {
    if (typeof value === "string") {
      const url = absoluteWebUrl(value);
      if (url !== null && url.origin !== origin) {
        found.push({ pointer, url: value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${pointer}/${index}`);
      });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [field, item] of Object.entries(value)) {
        walk(item as JsonValue, `${pointer}/${escapePointer(field)}`);
      }
    }
  };
  walk(document, "");
  return found;
}

export interface StoredDocumentViolation {
  /** The object key of the document. */
  readonly key: string;
  /** Foreign references in it; empty when the object is not a JSON document at all. */
  readonly references: readonly ForeignReference[];
  /** Why the object could not be checked, when it could not. */
  readonly unreadable?: string;
}

async function readAll(body: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Checks every stored event and class document, and lists each one that is
 * not self-contained. An empty answer means the documents can be relocated by
 * moving files.
 */
export async function checkStoredDocuments(
  storage: MetadataStorage,
  publicUrl: string,
): Promise<StoredDocumentViolation[]> {
  const violations: StoredDocumentViolation[] = [];
  for (const prefix of DOCUMENT_PREFIXES) {
    for await (const key of storage.list(prefix)) {
      const object = await storage.get(key);
      if (object === null) continue;
      let document: JsonValue;
      try {
        document = JSON.parse(await readAll(object.body)) as JsonValue;
      } catch (error) {
        violations.push({ key, references: [], unreadable: (error as Error).message });
        continue;
      }
      const references = foreignReferences(document, publicUrl);
      if (references.length > 0) {
        violations.push({ key, references });
      }
    }
  }
  return violations;
}
