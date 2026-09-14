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
