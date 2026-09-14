/**
 * Metadata locators (`REQ-MD-1`, `AD-22`, `F-026` plan §5.1).
 *
 * A locator is a stable HTTPS URL: an edit to the document changes the
 * document, never the locator. An event's locator is recorded on the ledger when
 * the event is created. A ticket carries only its class identifier, and any
 * client derives the class document's locator from it — so issuing a ticket
 * never creates a document, and a million tickets of one class share one.
 */

/** The public origin Kippu serves metadata from (`AD-22`). */
export const METADATA_ORIGIN = "https://meta.kippu.rocks";

const ID = /^[0-9a-f]{64}$/;

function originOf(publicUrl: string): string {
  const url = new URL(publicUrl);
  if (url.protocol !== "https:" || url.origin !== publicUrl) {
    throw new TypeError(`a metadata origin is an https origin with no path, not "${publicUrl}"`);
  }
  return url.origin;
}

function identifier(kind: string, id: string): string {
  if (!ID.test(id)) {
    throw new TypeError(`${kind} is 64 lower-case hex characters, not "${id}"`);
  }
  return id;
}

/** The locator of an event's document: `<origin>/v0/events/<EventId>.json`. */
export function eventLocator(eventId: string, origin: string = METADATA_ORIGIN): string {
  return `${originOf(origin)}/v0/events/${identifier("an EventId", eventId)}.json`;
}

/** The locator of a ticket class's document: `<origin>/v0/classes/<ClassId>.json`. */
export function classLocator(classId: string, origin: string = METADATA_ORIGIN): string {
  return `${originOf(origin)}/v0/classes/${identifier("a ClassId", classId)}.json`;
}
