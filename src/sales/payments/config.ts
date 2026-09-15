/**
 * Which payment provider checkout uses (`T-022-01`; `F-022` plan §5.4), read
 * from the environment.
 *
 * `KIPPU_PAYMENTS_PROVIDER` names it: `test` or `bloque`.
 * - `production` must name `bloque`.
 * - `staging` must name one, with no default: `test` for a stack with no real
 *   provider (kippu-e2e), `bloque` otherwise.
 * - `development` and `test` may leave it unset: Bloque when its credentials are
 *   set, the test provider otherwise.
 * - `test` is refused in `production`, and whenever any Bloque credential is set,
 *   so the two are never both active.
 *
 * Bloque's credentials are environment configuration, supplied for a
 * deployment and never committed: `KIPPU_BLOQUE_PAYMENTS_MODE`,
 * `KIPPU_BLOQUE_PAYMENTS_SECRET_KEY` and `KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET`,
 * all three or none. `KIPPU_PUBLIC_URL` is kippu-api's public origin, where
 * webhooks are sent.
 */
import type { Config, Environment } from "../../config.js";
import type { BloquePaymentsConfig } from "./bloque.js";

export type PaymentsConfig = (
  | { readonly provider: "test" }
  | { readonly provider: "bloque"; readonly bloque: BloquePaymentsConfig }
) & {
  /**
   * kippu-api's public origin (`KIPPU_PUBLIC_URL`), where the provider sends
   * webhooks. Required with Bloque; `http://localhost:8080` otherwise by default.
   */
  readonly publicUrl: string;
};

export class PaymentsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentsConfigError";
  }
}

/** kippu-api's public origin in development, when none is configured. */
const DEFAULT_PUBLIC_URL = "http://localhost:8080";

/** An http(s) origin, with no path, from `KIPPU_PUBLIC_URL`, when set. */
function readPublicUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentsConfigError("KIPPU_PUBLIC_URL is not a URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value) {
    throw new PaymentsConfigError("KIPPU_PUBLIC_URL must be an http(s) origin, with no path");
  }
  return url.origin;
}

const KEYS = [
  "KIPPU_BLOQUE_PAYMENTS_MODE",
  "KIPPU_BLOQUE_PAYMENTS_SECRET_KEY",
  "KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET",
] as const;

/** A secret key's prefix for each mode: a sandbox key never reaches production, nor the reverse. */
const KEY_PREFIX = { sandbox: "sk_test_", production: "sk_live_" } as const;

const PROVIDERS = ["test", "bloque"] as const;

export function loadPaymentsConfig(
  ledgerEnvironment: Config["ledgerEnvironment"],
  env: Environment = process.env,
): PaymentsConfig {
  const publicUrl = readPublicUrl(env.KIPPU_PUBLIC_URL);
  const set = KEYS.filter((key) => env[key] !== undefined && env[key] !== "");
  const named = env.KIPPU_PAYMENTS_PROVIDER;
  let provider: PaymentsConfig["provider"];
  if (named === undefined || named === "") {
    if (ledgerEnvironment === "staging" || ledgerEnvironment === "production") {
      throw new PaymentsConfigError(
        `KIPPU_LEDGER_ENVIRONMENT=${ledgerEnvironment} needs KIPPU_PAYMENTS_PROVIDER: ` +
          (ledgerEnvironment === "production" ? "bloque" : "test or bloque"),
      );
    }
    provider = set.length === 0 ? "test" : "bloque";
  } else {
    const found = PROVIDERS.find((candidate) => candidate === named);
    if (found === undefined) {
      throw new PaymentsConfigError(
        `KIPPU_PAYMENTS_PROVIDER must be test or bloque, not "${named}"`,
      );
    }
    provider = found;
  }

  if (provider === "test") {
    if (ledgerEnvironment === "production") {
      throw new PaymentsConfigError(
        "the test payment provider is refused in production: use bloque",
      );
    }
    if (set.length > 0) {
      throw new PaymentsConfigError(
        `KIPPU_PAYMENTS_PROVIDER=test is refused while Bloque credentials are set (${set.join(", ")}): ` +
          "the test provider and Bloque are never both active",
      );
    }
    return { provider: "test", publicUrl: publicUrl ?? DEFAULT_PUBLIC_URL };
  }

  if (set.length === 0) {
    throw new PaymentsConfigError(`Bloque payments need ${KEYS.join(", ")}`);
  }
  if (set.length !== KEYS.length) {
    const missing = KEYS.filter((key) => !set.includes(key));
    throw new PaymentsConfigError(
      `Bloque payments need ${KEYS.join(", ")}: ${missing.join(", ")} unset`,
    );
  }
  const mode = env.KIPPU_BLOQUE_PAYMENTS_MODE;
  if (mode !== "sandbox" && mode !== "production") {
    throw new PaymentsConfigError("KIPPU_BLOQUE_PAYMENTS_MODE must be sandbox or production");
  }
  const secretKey = env.KIPPU_BLOQUE_PAYMENTS_SECRET_KEY as string;
  if (!secretKey.startsWith(KEY_PREFIX[mode])) {
    throw new PaymentsConfigError(
      `KIPPU_BLOQUE_PAYMENTS_SECRET_KEY must be a ${KEY_PREFIX[mode]} key in ${mode} mode`,
    );
  }
  if (publicUrl === undefined) {
    throw new PaymentsConfigError(
      "KIPPU_PUBLIC_URL is required with Bloque payments: the origin its webhooks are sent to",
    );
  }
  return {
    provider: "bloque",
    publicUrl,
    bloque: {
      mode,
      secretKey,
      webhookSecret: env.KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET as string,
    },
  };
}
