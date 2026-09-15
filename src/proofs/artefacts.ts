/**
 * Capacity proof artefacts, and the private object storage that holds them
 * (`T-021-08`; `REQ-EV-6`, `NFR-6`; `F-021` plan §5.4).
 *
 * An artefact — a fire-safety certificate, a venue licence — will contain venue
 * and possibly personal data. Kippu retains it; it never reaches the ledger, and
 * it is never publicly served. It is therefore kept in a bucket of its own, not
 * the metadata bucket the public edge serves: reading it back needs this
 * process's credentials, and only a reviewer's procedure does so.
 *
 * **Types.** PDF, JPEG and PNG, checked by their signatures.
 *
 * **Size.** At most {@link MAX_PROOF_ARTEFACT_BYTES} once decoded, so the upload
 * fits a tRPC request (`TRPC_BODY_LIMIT`).
 */
import type { Readable } from "node:stream";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { Environment } from "../config.js";
import {
  loadMetadataConfig,
  MetadataConfigError,
  type ObjectStorageConfig,
} from "../metadata/config.js";
import { isObjectKey } from "../metadata/storage.js";
import type { ProofArtefactMediaType } from "./ports.js";

/** The largest artefact accepted, in bytes. */
export const MAX_PROOF_ARTEFACT_BYTES = 2 * 1024 * 1024;

/** Stored with every artefact: never cached by anything between the store and Kippu. */
export const PROOF_ARTEFACT_CACHE_CONTROL = "private, no-store";

export const PROOF_ARTEFACT_MEDIA_TYPES: readonly ProofArtefactMediaType[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
];

/** Where a request's artefact is stored. */
export const proofArtefactKey = (requestId: string) => `capacity-proofs/${requestId}`;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

/** The type an artefact's bytes are, by their signature; `null` when none of the accepted types. */
export function sniffArtefactType(bytes: Uint8Array): ProofArtefactMediaType | null {
  if (startsWith(bytes, PDF_SIGNATURE)) return "application/pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  return null;
}

/** Standard base64 with padding, canonical: the only encoding accepted. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ArtefactCheck =
  | {
      readonly ok: true;
      readonly mediaType: ProofArtefactMediaType;
      readonly bytes: Uint8Array;
    }
  | { readonly ok: false; readonly reason: string };

/** Decodes and checks an artefact against the type and size limits. */
export function checkArtefact(mediaType: string, data: string): ArtefactCheck {
  if (!(PROOF_ARTEFACT_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    return {
      ok: false,
      reason: `an artefact is one of ${PROOF_ARTEFACT_MEDIA_TYPES.join(", ")}, not ${mediaType}`,
    };
  }
  const tooLarge = `an artefact is at most ${MAX_PROOF_ARTEFACT_BYTES} bytes`;
  if (data.length > Math.ceil(MAX_PROOF_ARTEFACT_BYTES / 3) * 4) {
    return { ok: false, reason: tooLarge };
  }
  if (!BASE64.test(data)) {
    return { ok: false, reason: "the artefact data is not standard base64" };
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.length === 0) return { ok: false, reason: "the artefact is empty" };
  if (bytes.length > MAX_PROOF_ARTEFACT_BYTES) return { ok: false, reason: tooLarge };
  if (sniffArtefactType(bytes) !== mediaType) {
    return { ok: false, reason: `the artefact's bytes are not ${mediaType}` };
  }
  return { ok: true, mediaType: mediaType as ProofArtefactMediaType, bytes };
}

/** Private object storage for capacity proof artefacts. */
export interface ProofArtefactStorage {
  put(key: string, bytes: Uint8Array, options: { contentType: string }): Promise<void>;
  /** The artefact's bytes and type, or `null` when there is none at `key`. */
  get(key: string): Promise<{ readonly contentType: string; readonly bytes: Uint8Array } | null>;
}

/** No proof storage configured: requests for an increase, and artefact reads, fail. */
export const NO_PROOF_ARTEFACT_STORAGE: ProofArtefactStorage = {
  async put() {
    throw new Error("no capacity proof storage is configured (KIPPU_PROOFS_S3_BUCKET)");
  },
  async get() {
    throw new Error("no capacity proof storage is configured (KIPPU_PROOFS_S3_BUCKET)");
  },
};

/** Proof storage over an S3-compatible bucket: MinIO locally and in CI. */
export function createS3ProofArtefactStorage(config: ObjectStorageConfig): ProofArtefactStorage {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
  });
  const Bucket = config.bucket;
  return {
    async put(key, bytes, { contentType }) {
      if (!isObjectKey(key)) throw new TypeError(`not an object key: "${key}"`);
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          CacheControl: PROOF_ARTEFACT_CACHE_CONTROL,
        }),
      );
    },
    async get(key) {
      if (!isObjectKey(key)) return null;
      try {
        const output = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (output.Body === undefined) throw new Error("the object store returned no body");
        const chunks: Buffer[] = [];
        for await (const chunk of output.Body as Readable) chunks.push(Buffer.from(chunk));
        return {
          contentType: output.ContentType ?? "application/octet-stream",
          bytes: new Uint8Array(Buffer.concat(chunks)),
        };
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
          return null;
        }
        throw error;
      }
    },
  };
}

/**
 * The proof bucket's configuration: `KIPPU_PROOFS_S3_BUCKET`, on the same object
 * store as metadata (its endpoint, region and credentials). Refused when it names
 * the metadata bucket, which the public edge serves.
 */
export function loadProofStorageConfig(env: Environment = process.env): ObjectStorageConfig {
  const bucket = env.KIPPU_PROOFS_S3_BUCKET;
  if (bucket === undefined || bucket === "") {
    throw new MetadataConfigError("KIPPU_PROOFS_S3_BUCKET is required: the capacity proof bucket");
  }
  const metadata = loadMetadataConfig(env).storage;
  if (bucket === metadata.bucket) {
    throw new MetadataConfigError(
      "KIPPU_PROOFS_S3_BUCKET must not be the metadata bucket: metadata is served publicly",
    );
  }
  return { ...metadata, bucket };
}
