import { TRPCError } from "@trpc/server";

/**
 * An error identified by a `SPEC.md` §10 code, such as `ERR-EventNotFound`.
 *
 * Only the code is required. The Ticketto SDK's own error type will satisfy
 * this shape once it is wired in; nothing here depends on it.
 */
export interface SpecError {
  readonly code: string;
}

/** `SPEC.md` §10 names every error `ERR-<PascalCaseName>`. */
const SPEC_ERROR_CODE = /^ERR-[A-Z][A-Za-z]*$/;

export function isSpecErrorCode(code: string): boolean {
  return SPEC_ERROR_CODE.test(code);
}

/**
 * Carries a §10 code through tRPC's error pipeline to the error formatter,
 * which copies it into the response verbatim (`REQ-Q-3`).
 */
export class SpecErrorCause extends Error {
  readonly specCode: string;

  constructor(specCode: string) {
    super(specCode);
    this.name = "SpecErrorCause";
    this.specCode = specCode;
  }
}

type TRPCErrorCode = TRPCError["code"];

/**
 * The HTTP-level class of a §10 error. It only chooses a transport status; the
 * reason a client shows is always the §10 code itself.
 */
function transportCode(specCode: string): TRPCErrorCode {
  if (specCode.endsWith("NotFound")) {
    return "NOT_FOUND";
  }
  if (specCode === "ERR-NotOwner" || specCode === "ERR-InvalidAuthorisation") {
    return "FORBIDDEN";
  }
  if (specCode === "ERR-LedgerUnavailable") {
    return "SERVICE_UNAVAILABLE";
  }
  if (specCode.endsWith("Exists")) {
    return "CONFLICT";
  }
  return "UNPROCESSABLE_CONTENT";
}

/**
 * Maps an error carrying a §10 code to a tRPC error that carries the code
 * verbatim. A code that is not a §10 code is not passed on: the client sees an
 * internal error, with no detail from wherever the error arose.
 */
export function toTRPCError(error: SpecError): TRPCError {
  if (!isSpecErrorCode(error.code)) {
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  }
  return new TRPCError({
    code: transportCode(error.code),
    message: error.code,
    cause: new SpecErrorCause(error.code),
  });
}
