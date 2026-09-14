/**
 * Image upload for event documents (`T-026-06`; `US-A3`, `REQ-MD-1`, `REQ-MD-4`,
 * `F-026` plan §5.3).
 *
 * Every URL a document holds is at the metadata origin, so an organiser's
 * imagery is uploaded into metadata storage rather than linked from elsewhere.
 * An image is stored at `v0/images/<EventId>/<SHA-256 of its bytes>.<ext>`:
 * public, served like every other object, named by its content — so the bytes
 * at a URL never change, and an upload repeated answers the same URL.
 *
 * **Types.** JPEG, PNG and WebP only: raster formats with no active content and
 * no references of their own. SVG is refused, since it can carry script and
 * external references a document's self-containment check cannot see into.
 * The bytes must be the type declared, by their signature.
 *
 * **Size.** At most {@link MAX_IMAGE_BYTES} once decoded.
 */
import { createHash } from "node:crypto";
import type { ImageMediaType } from "./ports.js";

/** The largest image accepted, in bytes. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** The accepted image types, each with its file extension. */
export const IMAGE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Where images are stored: outside the document prefixes, so no sweep reads them as documents. */
export const IMAGE_PREFIX = "v0/images/";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

/** The type an image's bytes are, by their signature; `null` when none of the accepted types. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** Standard base64 with padding, canonical: the only encoding accepted. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ImageCheck =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

/** Decodes and checks an upload against the type and size limits. */
export function checkImage(mediaType: string, data: string): ImageCheck {
  if (!Object.hasOwn(IMAGE_EXTENSIONS, mediaType)) {
    return {
      ok: false,
      reason: `an image is one of ${Object.keys(IMAGE_EXTENSIONS).join(", ")}, not ${mediaType}`,
    };
  }
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    return { ok: false, reason: `an image is at most ${MAX_IMAGE_BYTES} bytes` };
  }
  if (!BASE64.test(data)) {
    return { ok: false, reason: "the image data is not standard base64" };
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.length === 0) {
    return { ok: false, reason: "the image is empty" };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `an image is at most ${MAX_IMAGE_BYTES} bytes` };
  }
  if (sniffImageType(bytes) !== mediaType) {
    return { ok: false, reason: `the image's bytes are not ${mediaType}` };
  }
  return { ok: true, bytes };
}

/** The object key an image is stored at. */
export function imageKey(event: string, mediaType: ImageMediaType, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${IMAGE_PREFIX}${event}/${digest}.${IMAGE_EXTENSIONS[mediaType]}`;
}
