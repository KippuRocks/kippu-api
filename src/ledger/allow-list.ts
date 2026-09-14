import type { CommandInput, CommandKind, PassPresentation, SignedAccessPass } from "@ticketto/sdk";

/**
 * The `NFR-6` allow-list: every field Kippu may pass into an SDK command, by
 * command kind, down to nested objects. Nothing personal appears in any of
 * them, and nothing outside them reaches the SDK.
 *
 * The allow-list is checked against the SDK surface at compile time: a field
 * added to a command input fails type-checking here until it is listed, so a
 * reviewer decides whether it is personal data.
 */

/** A value with no fields of its own: an identifier, a number, bytes, `null`. */
export const LEAF = "leaf";

export type FieldSpec =
  | typeof LEAF
  | readonly [FieldSpec]
  | { readonly [field: string]: FieldSpec };

type Fields<T> = { readonly [Field in keyof T]-?: FieldSpec };

const zone = { id: LEAF, kind: LEAF } as const;
const placement = { kind: LEAF, position: LEAF, discriminator: LEAF } as const;
const policy = { kind: LEAF, max: LEAF, until: LEAF } as const;
const restrictions = { cannotResale: LEAF, cannotTransfer: LEAF } as const;

export const COMMAND_INPUT_ALLOW_LIST: {
  readonly [Kind in CommandKind]: Fields<CommandInput<Kind>>;
} = {
  createEvent: { salt: LEAF, zones: [zone], capacity: LEAF, metadata: LEAF },
  setEventStatus: { event: LEAF, status: LEAF },
  setEventCapacity: { event: LEAF, capacity: LEAF, proof: LEAF },
  addZone: { event: LEAF, zone },
  removeZone: { event: LEAF, zone: LEAF },
  issueTicket: {
    event: LEAF,
    zone: LEAF,
    placement,
    class: LEAF,
    provenance: LEAF,
    policy,
    restrictions,
    holder: LEAF,
    metadata: LEAF,
  },
  transferTicket: { event: LEAF, ticket: LEAF, receiver: LEAF },
  removeRestriction: { event: LEAF, ticket: LEAF, restriction: LEAF },
  registerCredential: { account: LEAF, registration: LEAF },
};

export const PASS_ALLOW_LIST: Fields<SignedAccessPass> = {
  pass: { ticket: LEAF, holder: LEAF, id: LEAF, notBefore: LEAF, notAfter: LEAF },
  authorisation: LEAF,
};

export const PRESENTATION_ALLOW_LIST: Fields<PassPresentation> = { presentedAt: LEAF };

export class PersonalDataBoundaryError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`NFR-6: "${field}" is not on the allow-list of fields that may reach the ledger`);
    this.name = "PersonalDataBoundaryError";
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

/**
 * Throws unless every field of `value`, at every depth, is on `spec`. The
 * compile-time check (`Allowed`) catches what the compiler can see; this
 * catches the rest — values built at runtime, or cast.
 */
export function assertAllowed(value: unknown, spec: FieldSpec, path: string): void {
  if (spec === LEAF) {
    if (isPlainObject(value) || Array.isArray(value)) {
      throw new PersonalDataBoundaryError(path);
    }
    return;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) {
      throw new PersonalDataBoundaryError(path);
    }
    value.forEach((item, index) => {
      assertAllowed(item, spec[0] as FieldSpec, `${path}[${index}]`);
    });
    return;
  }
  if (!isPlainObject(value)) {
    throw new PersonalDataBoundaryError(path);
  }
  const fields = spec as { readonly [field: string]: FieldSpec };
  for (const [field, item] of Object.entries(value)) {
    const nested = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (nested === undefined) {
      throw new PersonalDataBoundaryError(`${path}.${field}`);
    }
    assertAllowed(item, nested, `${path}.${field}`);
  }
}

type Primitive = string | number | bigint | boolean | symbol | null | undefined;

/**
 * `Input`, provided it has no field `Shape` does not, at any depth. A field
 * outside the shape is typed `never`, so passing one fails type-checking even
 * from a variable, where TypeScript's excess-property check does not apply.
 */
export type Allowed<Input, Shape> = Shape extends Primitive | Uint8Array
  ? Input
  : Shape extends readonly (infer Item)[]
    ? Input extends readonly (infer InputItem)[]
      ? readonly Allowed<InputItem, Item>[]
      : never
    : {
        readonly [Field in keyof Input]: Field extends keyof Shape
          ? Allowed<Input[Field], Shape[Field]>
          : never;
      };
