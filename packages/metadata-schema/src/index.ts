/**
 * `@kippu/metadata-schema` — the `C6` contract.
 *
 * JSON Schemas (2020-12) for Kippu's public metadata documents. Every document
 * declares, in `$schema`, the versioned schema it conforms to (`REQ-MD-4`).
 * A minor version only adds optional fields; a breaking change is a new major
 * version, served side by side.
 *
 * The schema files themselves are exported too, as `@kippu/metadata-schema/event/1.0.json`
 * and `@kippu/metadata-schema/class/1.0.json`.
 */
import classJson from "../schemas/class/1.0.json" with { type: "json" };
import eventJson from "../schemas/event/1.0.json" with { type: "json" };

export {
  DENIED_FIELD_NAME_FRAGMENTS,
  DENIED_FIELD_NAMES,
  isDeniedFieldName,
  lintPersonalData,
  normaliseFieldName,
  type PersonalDataViolation,
} from "./personal-data.js";

/** A JSON Schema document, as this package publishes it. */
export interface JsonSchema {
  readonly $schema: string;
  readonly $id: string;
  readonly [keyword: string]: unknown;
}

/** Where every schema version lives. */
export const SCHEMA_BASE_URL = "https://meta.kippu.rocks/v0/schemas/";

export const EVENT_SCHEMA_ID = "https://meta.kippu.rocks/v0/schemas/event/1.0.json";
export const CLASS_SCHEMA_ID = "https://meta.kippu.rocks/v0/schemas/class/1.0.json";

/** The event document schema, version 1.0. */
export const eventSchema: JsonSchema = eventJson;

/** The ticket class document schema, version 1.0. */
export const classSchema: JsonSchema = classJson;

/** Every schema this package publishes. */
export const schemas: readonly JsonSchema[] = [eventSchema, classSchema];
