import {
  EVENT_SCHEMA_ID,
  eventSchema,
  type JsonSchema,
  lintPersonalData,
  type PersonalDataViolation,
} from "@kippurocks/metadata-schema";

/** The schema an event document must declare, typed from the packed package. */
export const declaredSchema: string = EVENT_SCHEMA_ID;

export const schema: JsonSchema = eventSchema;

export function personalDataFields(candidate: unknown): readonly PersonalDataViolation[] {
  return lintPersonalData(candidate);
}
