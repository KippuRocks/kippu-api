/**
 * Which payment provider checkout uses (`T-022-01`; `F-022` plan §5.4), read
 * from the environment.
 *
 * Bloque's credentials are environment configuration, supplied for a
 * deployment and never committed: `KIPPU_BLOQUE_PAYMENTS_MODE`,
 * `KIPPU_BLOQUE_PAYMENTS_SECRET_KEY` and `KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET`,
 * all three or none. With none, the deterministic test provider is used — only
 * where the ledger is `backend-memory` (`development`, `test`); `staging` and
 * `production` refuse to take payments without a real provider.
 */
import type { Config, Environment } from "../../config.js";
import type { BloquePaymentsConfig } from "./bloque.js";

export type PaymentsConfig =
  | { readonly provider: "test" }
  | { readonly provider: "bloque"; readonly bloque: BloquePaymentsConfig };

export class PaymentsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentsConfigError";
  }
}

const KEYS = [
  "KIPPU_BLOQUE_PAYMENTS_MODE",
  "KIPPU_BLOQUE_PAYMENTS_SECRET_KEY",
  "KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET",
] as const;

/** A secret key's prefix for each mode: a sandbox key never reaches production, nor the reverse. */
const KEY_PREFIX = { sandbox: "sk_test_", production: "sk_live_" } as const;

export function loadPaymentsConfig(
  ledgerEnvironment: Config["ledgerEnvironment"],
  env: Environment = process.env,
): PaymentsConfig {
  const set = KEYS.filter((key) => env[key] !== undefined && env[key] !== "");
  if (set.length === 0) {
    if (ledgerEnvironment === "development" || ledgerEnvironment === "test") {
      return { provider: "test" };
    }
    throw new PaymentsConfigError(
      `KIPPU_LEDGER_ENVIRONMENT=${ledgerEnvironment} needs a payment provider: set ${KEYS.join(", ")}`,
    );
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
  return {
    provider: "bloque",
    bloque: {
      mode,
      secretKey,
      webhookSecret: env.KIPPU_BLOQUE_PAYMENTS_WEBHOOK_SECRET as string,
    },
  };
}
