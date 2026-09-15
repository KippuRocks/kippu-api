/**
 * Publishing the metadata schemas at their stable URLs (`REQ-MD-4`, `F-026`
 * §5.2): every schema file `@kippurocks/metadata-schema` exports is stored, byte for
 * byte, at the object key its `$id` names under the public URL. A document's
 * `$schema` therefore resolves to the very file it was validated against.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { MetadataStorage } from "./storage.js";

/** The media type of a JSON Schema (JSON Schema 2020-12, core §4.2). */
export const SCHEMA_CONTENT_TYPE = "application/schema+json";

/** A schema file export of `@kippurocks/metadata-schema`: `./<document>/<major>.<minor>.json`. */
const SCHEMA_EXPORT = /^\.\/[a-z][a-z0-9-]*\/\d+\.\d+\.json$/;

export interface SchemaFile {
  /** The schema's `$id`: its stable public URL. */
  readonly id: string;
  /** The file's bytes, exactly as the package ships them. */
  readonly bytes: Uint8Array;
}

/** Every schema file `@kippurocks/metadata-schema` exports. */
export async function schemaFiles(): Promise<readonly SchemaFile[]> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@kippurocks/metadata-schema/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    exports: Record<string, unknown>;
  };
  const files: SchemaFile[] = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (!SCHEMA_EXPORT.test(subpath) || typeof target !== "string") continue;
    const bytes = await readFile(join(dirname(manifestPath), target));
    const schema = JSON.parse(bytes.toString("utf8")) as { $id?: unknown };
    if (typeof schema.$id !== "string") {
      throw new Error(`@kippurocks/metadata-schema${subpath.slice(1)} declares no $id`);
    }
    files.push({ id: schema.$id, bytes: new Uint8Array(bytes) });
  }
  return files;
}

/**
 * The object key a public URL is served from: its path under `publicUrl`.
 * Throws when `url` is not under `publicUrl`.
 */
export function objectKeyOf(publicUrl: string, url: string): string {
  const base = new URL(publicUrl);
  const target = new URL(url);
  if (target.origin !== base.origin || target.search !== "" || target.hash !== "") {
    throw new Error(`${url} is not served from ${publicUrl}`);
  }
  return decodeURIComponent(target.pathname.slice(1));
}

/**
 * Stores every schema at the key its `$id` names. Publishing again replaces
 * each object with identical bytes, so it is safe to repeat.
 */
export async function publishSchemas(
  storage: MetadataStorage,
  publicUrl: string,
): Promise<readonly { id: string; key: string }[]> {
  const published: { id: string; key: string }[] = [];
  for (const file of await schemaFiles()) {
    const key = objectKeyOf(publicUrl, file.id);
    await storage.put(key, file.bytes, { contentType: SCHEMA_CONTENT_TYPE });
    published.push({ id: file.id, key });
  }
  return published;
}
