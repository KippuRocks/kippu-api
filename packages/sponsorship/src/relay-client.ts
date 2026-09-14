// The sponsor client every Ticketto client in Kippu uses — kippu-api, Saifu and
// Iriguchi — to obtain sponsorships from the relay (`F-023`, `T-023-07`;
// `REQ-SP-1a`). It is the SDK's `Sponsor`, so `createTicketto` sponsors every
// signed command and access pass through it, and no flow built on the SDK ever
// sees a fee, a balance or a funding step.
//
// It speaks the relay's documented plain-HTTP API (docs/sponsor-relay.md in
// kippu-api) with `fetch` only, and runs on Node 24 and Hermes alike.

import { encodeSignedAccessPass, encodeSignedCommand } from "@ticketto/profile-v0";
import type {
  Cursor,
  Result,
  SignedAccessPass,
  SignedCommand,
  Sponsor,
  Sponsorship,
} from "@ticketto/sdk";

export interface RelaySponsorOptions {
  /** The relay's base URL, such as `https://sponsor.example`. */
  readonly url: string;
  /**
   * The receipt cursor of the caller's latest write, if it has one: sent as
   * `after`, so a relay whose copy of ledger facts lags behind that write waits
   * for it instead of refusing (`REQ-SP-5`). Called once per sponsorship.
   */
  readonly receiptCursor?: () => Cursor | undefined;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * How many times a lagging or unavailable relay, or a failed request, is
   * tried in all. Defaults to 5.
   */
  readonly attempts?: number;
  /** The first backoff between attempts, in ms, doubling each time. Defaults to 250. */
  readonly backoff?: number;
  /** Waits `ms` milliseconds. Defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The relay answered in a way the documented API does not allow: a defect on one side. */
export class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayProtocolError";
  }
}

const HEX_DIGITS = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX_DIGITS.charAt(byte >> 4) + HEX_DIGITS.charAt(byte & 15);
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

interface RelayBody {
  readonly sponsorship?: unknown;
  readonly error?: { readonly code?: unknown; readonly detail?: unknown };
}

/** `Retry-After` in seconds, as ms; `null` when absent or not a number of seconds. */
function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim()) * 1000;
}

/**
 * A `Sponsor` backed by the relay at `options.url`.
 *
 * - `200` is the sponsorship.
 * - `403 ERR-SponsorshipRefused` is returned as that error, never retried.
 * - `503 lagging`, `503 unavailable` and failed requests are retried with
 *   backoff — honouring `Retry-After` — resending the same input. When the
 *   attempts run out, the result is `ERR-LedgerUnavailable`: the write cannot
 *   reach the ledger now, and may later.
 * - Any other answer, `400 malformed` included, is a defect and throws
 *   `RelayProtocolError`.
 */
export function createRelaySponsor(options: RelaySponsorOptions): Sponsor {
  const doFetch = options.fetch ?? globalThis.fetch;
  const attempts = options.attempts ?? 5;
  const backoff = options.backoff ?? 250;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }
  const endpoint = new URL("/v0/sponsor", options.url).toString();

  return {
    async sponsor(input: SignedCommand | SignedAccessPass): Promise<Result<Sponsorship>> {
      const after = options.receiptCursor?.();
      const body = JSON.stringify({
        input:
          "pass" in input
            ? { kind: "pass", bytes: toHex(encodeSignedAccessPass(input)) }
            : { kind: "command", bytes: toHex(encodeSignedCommand(input)) },
        ...(after === undefined ? {} : { after }),
      });

      let lastProblem = "the relay was not reached";
      for (let attempt = 1; attempt <= attempts; attempt++) {
        let response: Response;
        try {
          response = await doFetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
        } catch (error) {
          lastProblem = `the relay could not be reached: ${String(error)}`;
          if (attempt < attempts) await sleep(backoff * 2 ** (attempt - 1));
          continue;
        }
        let parsed: RelayBody;
        try {
          parsed = (await response.json()) as RelayBody;
        } catch {
          throw new RelayProtocolError(`the relay answered ${response.status} without JSON`);
        }
        const code = parsed.error?.code;
        const detail = typeof parsed.error?.detail === "string" ? parsed.error.detail : undefined;
        if (response.status === 200 && typeof parsed.sponsorship === "string") {
          const bytes = fromHex(parsed.sponsorship);
          if (bytes === null) throw new RelayProtocolError("the relay's sponsorship is not hex");
          return { ok: true, value: bytes as Sponsorship };
        }
        if (response.status === 403 && code === "ERR-SponsorshipRefused") {
          return {
            ok: false,
            error: detail === undefined ? { code } : { code, detail },
          };
        }
        if (response.status === 503 && (code === "lagging" || code === "unavailable")) {
          lastProblem = `the relay is ${code}${detail === undefined ? "" : `: ${detail}`}`;
          if (attempt < attempts) {
            await sleep(retryAfter(response) ?? backoff * 2 ** (attempt - 1));
          }
          continue;
        }
        throw new RelayProtocolError(
          `the relay answered ${response.status} ${String(code)}${detail === undefined ? "" : `: ${detail}`}`,
        );
      }
      return { ok: false, error: { code: "ERR-LedgerUnavailable", detail: lastProblem } };
    },
  };
}
