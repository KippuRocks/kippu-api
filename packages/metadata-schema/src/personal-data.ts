/**
 * The personal-data field lint (`NFR-6`, `REQ-MD-4`).
 *
 * Metadata documents are public by requirement, so no schema may declare a
 * field whose name says it holds personal data. An organiser who is a natural
 * person is described by a trading name, never by a personal one.
 *
 * Names are compared after normalisation — lower-case, letters and digits
 * only — so `first_name`, `firstName` and `FirstName` are one name.
 */

/** Field names denied outright, normalised. */
export const DENIED_FIELD_NAMES: readonly string[] = [
  // Names of a person.
  "firstname",
  "middlename",
  "lastname",
  "givenname",
  "familyname",
  "surname",
  "fullname",
  "legalname",
  "personalname",
  "birthname",
  "maidenname",
  "username",
  // Contact.
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "telephone",
  "mobile",
  "mobilenumber",
  "homeaddress",
  "personaladdress",
  "residentialaddress",
  "billingaddress",
  "shippingaddress",
  "ipaddress",
  // Identity documents and demographic data.
  "dateofbirth",
  "birthdate",
  "birthday",
  "dob",
  "age",
  "gender",
  "sex",
  "nationality",
  "nationalid",
  "idnumber",
  "identitynumber",
  "documentnumber",
  "passport",
  "passportnumber",
  "taxid",
  "taxnumber",
  "ssn",
  "socialsecuritynumber",
  "driverslicence",
  "driverslicense",
  // Payment.
  "cardnumber",
  "iban",
  "bankaccount",
  "bankaccountnumber",
  // People a ticket document must never name.
  "holdername",
  "ownername",
  "attendeename",
  "buyername",
  "customername",
  "contactname",
];

/**
 * Fragments denied anywhere in a normalised field name, so that a compound
 * such as `contactEmail` or `organiserPhoneNumber` is caught too. Each is
 * specific enough not to occur inside an innocent word.
 */
export const DENIED_FIELD_NAME_FRAGMENTS: readonly string[] = [
  "email",
  "phone",
  "passport",
  "birth",
  "firstname",
  "lastname",
  "surname",
  "fullname",
  "givenname",
  "familyname",
  "legalname",
  "personalname",
  "nationalid",
];

export interface PersonalDataViolation {
  /** JSON Pointer, within the schema, to where the field name appears. */
  readonly pointer: string;
  readonly field: string;
}

export function normaliseFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isDeniedFieldName(field: string): boolean {
  const name = normaliseFieldName(field);
  return (
    DENIED_FIELD_NAMES.includes(name) ||
    DENIED_FIELD_NAME_FRAGMENTS.some((fragment) => name.includes(fragment))
  );
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Keywords whose value is a single subschema. */
const SUBSCHEMA_KEYWORDS = [
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contentSchema",
] as const;

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

/** Keywords whose value maps arbitrary keys to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = ["$defs", "definitions", "patternProperties"] as const;

/**
 * Lists every field name a JSON Schema declares that the deny-list forbids:
 * names under `properties`, `required`, `dependentRequired` and
 * `dependentSchemas`, at any depth.
 */
export function lintPersonalData(schema: unknown): PersonalDataViolation[] {
  const violations: PersonalDataViolation[] = [];

  const check = (field: string, pointer: string): void => {
    if (isDeniedFieldName(field)) {
      violations.push({ pointer, field });
    }
  };

  const walk = (node: Json | undefined, pointer: string): void => {
    if (!isObject(node)) {
      return;
    }

    const { properties, required, dependentRequired, dependentSchemas } = node;

    if (isObject(properties)) {
      for (const [field, subschema] of Object.entries(properties)) {
        const at = `${pointer}/properties/${escapePointer(field)}`;
        check(field, at);
        walk(subschema, at);
      }
    }

    if (Array.isArray(required)) {
      required.forEach((field, index) => {
        if (typeof field === "string") {
          check(field, `${pointer}/required/${index}`);
        }
      });
    }

    if (isObject(dependentRequired)) {
      for (const [field, fields] of Object.entries(dependentRequired)) {
        const at = `${pointer}/dependentRequired/${escapePointer(field)}`;
        check(field, at);
        if (Array.isArray(fields)) {
          fields.forEach((dependent, index) => {
            if (typeof dependent === "string") {
              check(dependent, `${at}/${index}`);
            }
          });
        }
      }
    }

    if (isObject(dependentSchemas)) {
      for (const [field, subschema] of Object.entries(dependentSchemas)) {
        const at = `${pointer}/dependentSchemas/${escapePointer(field)}`;
        check(field, at);
        walk(subschema, at);
      }
    }

    for (const keyword of SUBSCHEMA_KEYWORDS) {
      walk(node[keyword], `${pointer}/${keyword}`);
    }

    for (const keyword of SUBSCHEMA_ARRAY_KEYWORDS) {
      const subschemas = node[keyword];
      if (Array.isArray(subschemas)) {
        subschemas.forEach((subschema, index) => {
          walk(subschema, `${pointer}/${keyword}/${index}`);
        });
      }
    }

    for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
      const map = node[keyword];
      if (isObject(map)) {
        for (const [key, subschema] of Object.entries(map)) {
          walk(subschema, `${pointer}/${keyword}/${escapePointer(key)}`);
        }
      }
    }
  };

  walk(schema as Json, "");
  return violations;
}
