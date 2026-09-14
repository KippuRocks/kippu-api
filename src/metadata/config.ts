/**
 * Configuration of metadata storage and serving (`F-026` §5.3), read from the
 * environment.
 *
 * No object store, CDN or DNS record exists yet. The public origin is a setting
 * that defaults to `https://meta.kippu.rocks` (`AD-22`), the domain every
 * locator and schema `$id` names; locally and in CI an S3-compatible stand-in
 * (MinIO) holds the objects and `src/metadata/edge.ts` stands in for the CDN.
 * A real provider is configured through the same keys.
 */
import type { Environment } from "../config.js";

/** Where metadata documents are publicly served (`AD-22`). */
export const DEFAULT_METADATA_PUBLIC_URL = "https://meta.kippu.rocks";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_EDGE_PORT = 8081;

export interface ObjectStorageConfig {
  readonly bucket: string;
  readonly region: string;
  /** An S3-compatible endpoint, such as a local MinIO. Absent means the provider's default. */
  readonly endpoint?: string;
  /** Path-style addressing (`<endpoint>/<bucket>/<key>`), as MinIO needs. */
  readonly forcePathStyle: boolean;
  /** Static credentials. Absent means the provider's default credential chain. */
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

export interface MetadataConfig {
  /**
   * The public origin documents and schemas are addressed at, with no trailing
   * slash. Locators and schema `$id`s name it; a local stand-in serves the same
   * paths on its own address.
   */
  readonly publicUrl: string;
  readonly storage: ObjectStorageConfig;
}

export interface MetadataEdgeConfig extends MetadataConfig {
  readonly host: string;
  readonly port: number;
}

export class MetadataConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataConfigError";
  }
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function readPublicUrl(value: string | undefined): string {
  if (!present(value)) return DEFAULT_METADATA_PUBLIC_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MetadataConfigError("KIPPU_METADATA_PUBLIC_URL is not a URL");
  }
  if (url.origin !== value) {
    throw new MetadataConfigError(
      "KIPPU_METADATA_PUBLIC_URL must be an origin: no path, no trailing slash",
    );
  }
  if (url.protocol !== "https:") {
    throw new MetadataConfigError("KIPPU_METADATA_PUBLIC_URL must use https");
  }
  return url.origin;
}

function readStorage(env: Environment): ObjectStorageConfig {
  const bucket = env.KIPPU_METADATA_S3_BUCKET;
  if (!present(bucket)) {
    throw new MetadataConfigError("KIPPU_METADATA_S3_BUCKET is required: the metadata bucket");
  }
  const endpoint = env.KIPPU_METADATA_S3_ENDPOINT;
  if (present(endpoint)) {
    try {
      new URL(endpoint);
    } catch {
      throw new MetadataConfigError("KIPPU_METADATA_S3_ENDPOINT is not a URL");
    }
  }
  const accessKeyId = env.KIPPU_METADATA_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.KIPPU_METADATA_S3_SECRET_ACCESS_KEY;
  if (present(accessKeyId) !== present(secretAccessKey)) {
    throw new MetadataConfigError(
      "KIPPU_METADATA_S3_ACCESS_KEY_ID and KIPPU_METADATA_S3_SECRET_ACCESS_KEY are set together",
    );
  }
  const pathStyle = env.KIPPU_METADATA_S3_FORCE_PATH_STYLE;
  if (present(pathStyle) && pathStyle !== "true" && pathStyle !== "false") {
    throw new MetadataConfigError("KIPPU_METADATA_S3_FORCE_PATH_STYLE must be true or false");
  }
  return {
    bucket,
    region: present(env.KIPPU_METADATA_S3_REGION) ? env.KIPPU_METADATA_S3_REGION : DEFAULT_REGION,
    ...(present(endpoint) ? { endpoint } : {}),
    forcePathStyle: pathStyle === "true",
    ...(present(accessKeyId) && present(secretAccessKey)
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  };
}

function readPort(value: string | undefined): number {
  if (!present(value)) return DEFAULT_EDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new MetadataConfigError(
      `KIPPU_METADATA_EDGE_PORT must be an integer between 0 and 65535, got "${value}"`,
    );
  }
  return port;
}

/** Only the public origin metadata locators name (`AD-22`), for a process with no storage configured. */
export function loadMetadataPublicUrl(env: Environment = process.env): string {
  return readPublicUrl(env.KIPPU_METADATA_PUBLIC_URL);
}

export function loadMetadataConfig(env: Environment = process.env): MetadataConfig {
  return { publicUrl: readPublicUrl(env.KIPPU_METADATA_PUBLIC_URL), storage: readStorage(env) };
}

/** The local CDN stand-in's configuration: the metadata configuration and where to listen. */
export function loadMetadataEdgeConfig(env: Environment = process.env): MetadataEdgeConfig {
  return {
    ...loadMetadataConfig(env),
    host: present(env.KIPPU_METADATA_EDGE_HOST) ? env.KIPPU_METADATA_EDGE_HOST : "0.0.0.0",
    port: readPort(env.KIPPU_METADATA_EDGE_PORT),
  };
}
