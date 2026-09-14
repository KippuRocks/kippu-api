import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe } from "vitest";
import type { ObjectStorageConfig } from "../../src/metadata/config.js";
import {
  METADATA_CACHE_CONTROL,
  type MetadataStorage,
  type ObjectHead,
} from "../../src/metadata/storage.js";

/**
 * An S3-compatible server the tests may create buckets on: locally the MinIO
 * from `compose.yaml`, in CI a MinIO container.
 */
const endpoint = process.env.KIPPU_TEST_S3_ENDPOINT;
const accessKeyId = process.env.KIPPU_TEST_S3_ACCESS_KEY_ID ?? "";
const secretAccessKey = process.env.KIPPU_TEST_S3_SECRET_ACCESS_KEY ?? "";

if ((endpoint === undefined || endpoint === "") && process.env.CI === "true") {
  throw new Error(
    "KIPPU_TEST_S3_ENDPOINT must be set in CI: object storage tests may not be skipped",
  );
}

/** `describe`, skipped when no test object store is configured locally. */
export const describeWithObjectStorage = describe.runIf(endpoint !== undefined && endpoint !== "");

export interface TestBucket {
  readonly config: ObjectStorageConfig;
  drop(): Promise<void>;
}

/** Creates a bucket of its own for one test file. */
export async function createTestBucket(): Promise<TestBucket> {
  if (endpoint === undefined || endpoint === "") {
    throw new Error("KIPPU_TEST_S3_ENDPOINT is not set");
  }
  const config: ObjectStorageConfig = {
    bucket: `kippu-test-${randomBytes(6).toString("hex")}`,
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  };
  const client = new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  return {
    config,
    async drop() {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: config.bucket }));
      const objects = (listed.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: objects } }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
      client.destroy();
    },
  };
}

/** Object storage in memory, for tests of what sits in front of it. */
export function memoryMetadataStorage(): MetadataStorage {
  const objects = new Map<string, { head: ObjectHead; bytes: Uint8Array }>();
  return {
    async put(key, body, { contentType }) {
      const etag = `"${createHash("md5").update(body).digest("hex")}"`;
      objects.set(key, {
        bytes: body.slice(),
        head: {
          contentType,
          cacheControl: METADATA_CACHE_CONTROL,
          etag,
          contentLength: body.length,
          lastModified: new Date(),
        },
      });
      return { etag };
    },
    async head(key) {
      return objects.get(key)?.head ?? null;
    },
    async get(key) {
      const object = objects.get(key);
      return object === undefined
        ? null
        : { head: object.head, body: Readable.from([Buffer.from(object.bytes)]) };
    },
  };
}
