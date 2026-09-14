/**
 * Object storage for public metadata: documents, schemas, and the images they
 * reference (`F-026` §5.3).
 *
 * `MetadataStorage` is the narrow surface the rest of Kippu uses. The S3
 * implementation speaks to any S3-compatible store: MinIO locally and in CI,
 * and whichever provider is chosen for deployment. No provider is chosen yet.
 *
 * What a CDN needs to serve an object correctly is stored with the object —
 * its `Content-Type` and `Cache-Control` — so a CDN in front of the bucket
 * passes them through without knowing anything about Kippu.
 */
import type { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { ObjectStorageConfig } from "./config.js";

/**
 * Public, and fresh for at most a minute: an edit to a document is visible to
 * every reader within a minute (`F-026` §5.3), and a reader revalidates with the
 * object's `ETag` after that.
 */
export const METADATA_CACHE_CONTROL = "public, max-age=60";

/** What a stored object is served with. */
export interface ObjectHead {
  readonly contentType: string;
  readonly cacheControl: string;
  /** The entity tag, quoted, as HTTP carries it. */
  readonly etag: string;
  readonly contentLength: number;
  readonly lastModified?: Date;
}

/** A stored object: its head, and its bytes as a stream. */
export interface StoredObject {
  readonly head: ObjectHead;
  readonly body: Readable;
}

export interface MetadataStorage {
  /** Stores `body` at `key`, replacing any object there. The key never changes on an edit. */
  put(key: string, body: Uint8Array, options: { contentType: string }): Promise<{ etag: string }>;
  /** The object's head, or `null` when there is no object at `key`. */
  head(key: string): Promise<ObjectHead | null>;
  /** The object, or `null` when there is no object at `key`. */
  get(key: string): Promise<StoredObject | null>;
}

/**
 * Whether `key` is an object key metadata may live at: `/`-separated segments
 * of letters, digits, `.`, `_` and `-`, none empty, none `.` or `..`.
 */
export function isObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) return false;
  return key
    .split("/")
    .every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function assertObjectKey(key: string): void {
  if (!isObjectKey(key)) throw new TypeError(`not a metadata object key: "${key}"`);
}

interface S3Head {
  readonly ContentType?: string | undefined;
  readonly CacheControl?: string | undefined;
  readonly ETag?: string | undefined;
  readonly ContentLength?: number | undefined;
  readonly LastModified?: Date | undefined;
}

function headOf(output: S3Head): ObjectHead {
  if (output.ETag === undefined) throw new Error("the object store returned no ETag");
  return {
    contentType: output.ContentType ?? "application/octet-stream",
    cacheControl: output.CacheControl ?? METADATA_CACHE_CONTROL,
    etag: output.ETag,
    contentLength: output.ContentLength ?? 0,
    ...(output.LastModified === undefined ? {} : { lastModified: output.LastModified }),
  };
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof S3ServiceException) return error.$metadata.httpStatusCode;
  return undefined;
}

export function createS3MetadataStorage(config: ObjectStorageConfig): MetadataStorage {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
  });
  const Bucket = config.bucket;

  return {
    async put(key, body, { contentType }) {
      assertObjectKey(key);
      const result = await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: METADATA_CACHE_CONTROL,
        }),
      );
      if (result.ETag === undefined) throw new Error("the object store returned no ETag");
      return { etag: result.ETag };
    },

    async head(key) {
      if (!isObjectKey(key)) return null;
      try {
        const output = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return headOf(output);
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },

    async get(key) {
      if (!isObjectKey(key)) return null;
      try {
        const output = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (output.Body === undefined) throw new Error("the object store returned no body");
        return { head: headOf(output), body: output.Body as Readable };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
  };
}
