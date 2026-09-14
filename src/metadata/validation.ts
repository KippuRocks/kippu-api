/**
 * Validating metadata documents against the schemas they declare (`REQ-MD-4`,
 * `F-026` plan §5.2, §5.4).
 *
 * Every schema `@kippu/metadata-schema` publishes is compiled under a strict
 * JSON Schema 2020-12 validator with formats. The schemas are closed, so a
 * field they do not declare — a personal-data field among them (`NFR-6`) — is
 * refused.
 */
import { schemas } from "@kippu/metadata-schema";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export type DocumentValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: readonly string[] };

export interface DocumentValidator {
  /** Validates `document` against the schema with `$id` `schemaId`. */
  validate(schemaId: string, document: unknown): DocumentValidation;
}

function describe(error: ErrorObject): string {
  const at = error.instancePath === "" ? "the document" : error.instancePath;
  const detail =
    error.keyword === "unevaluatedProperties" && "unevaluatedProperty" in error.params
      ? `: ${String(error.params.unevaluatedProperty)}`
      : "";
  return `${at} ${error.message ?? "is invalid"}${detail}`;
}

export function createDocumentValidator(): DocumentValidator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  for (const schema of schemas) {
    ajv.addSchema(schema);
  }
  return {
    validate(schemaId, document) {
      const check = ajv.getSchema(schemaId);
      if (check === undefined) {
        return { valid: false, errors: [`no schema is published at ${schemaId}`] };
      }
      if (check(document)) {
        return { valid: true };
      }
      return { valid: false, errors: (check.errors ?? []).map(describe) };
    },
  };
}
