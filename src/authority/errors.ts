/**
 * A failure identified by a `SPEC.md` §10 code: a ledger's verdict passed on
 * unchanged, or one of the platform errors Kippu raises itself
 * (`ERR-UnknownClass`, `ERR-ClassQuotaExceeded`; §10 note). Routers turn it into
 * a tRPC error carrying the code in `error.data.errorCode` (`toTRPCError`).
 */
export class SpecCodeError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "SpecCodeError";
    this.code = code;
  }
}

/**
 * A request refused before anything reaches the ledger, for a reason `SPEC.md`
 * §10 has no code for — a seat position that is not one of its zone's canonical
 * positions, say (`REQ-ID-3`). Routers turn it into a tRPC error of its
 * `transport` class — `BAD_REQUEST` unless said otherwise — carrying this
 * message, with no §10 code.
 */
export class RefusedRequest extends Error {
  readonly transport: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED";

  constructor(message: string, transport: RefusedRequest["transport"] = "BAD_REQUEST") {
    super(message);
    this.name = "RefusedRequest";
    this.transport = transport;
  }
}
