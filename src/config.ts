/**
 * The Kippu API's configuration, read from the environment.
 *
 * Every key is named here, and nothing else is read. In particular there is no
 * key for the ledger service's store: Kippu's business layer reaches ledger
 * state only through the Ticketto SDK (`REQ-SDK-9`), and its own store is a
 * separate PostgreSQL instance with its own credentials (`AD-20`).
 */
export interface Config {
  readonly host: string;
  readonly port: number;
  /** The Kippu store: a PostgreSQL connection URL, credentials included. */
  readonly databaseUrl: string;
  /**
   * Kippu's login relying party, for organiser passkeys. Its RP id is never
   * the holder credential's (`F-020` plan §8).
   */
  readonly login: { readonly id: string; readonly origins: readonly string[] };
  /** The WebAuthn RP id holder credentials are bound to — a profile parameter (`F-003` §5.3). */
  readonly holderRpId: string;
  /**
   * Which ledger, KMS and sponsor the domain services run over (`T-021-11`).
   * `development` and `test` use `backend-memory`, a software KMS and a
   * development sponsor; `production` is refused until real ones exist.
   */
  readonly ledgerEnvironment: "development" | "test" | "production";
  /**
   * The sponsor relay's base URL (`F-023`). When set, every ledger write is
   * sponsored through the relay's client (`createRelaySponsor`), with its
   * entitlements; when absent, `development` and `test` use the development
   * sponsor.
   */
  readonly sponsorRelayUrl?: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8080;

/**
 * libpq's variables. `pg` silently fills a connection's missing parts from
 * them, which would let credentials reach the process without passing through
 * this module. The store's URL must say everything.
 */
const LIBPQ_VARIABLE = /^PG[A-Z]+$/;

/**
 * Anything that looks like credentials for, or a route to, the ledger
 * service's database. `kippu-api` must never be given one (`REQ-SDK-9`).
 */
const LEDGER_STORE_VARIABLE = /^(LEDGER|TICKETTO)[A-Z0-9_]*_(DATABASE|DB|PG|POSTGRES)[A-Z0-9_]*$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

function readDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new ConfigError("KIPPU_DATABASE_URL is required: the Kippu store's PostgreSQL URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("KIPPU_DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError("KIPPU_DATABASE_URL must be a postgres:// or postgresql:// URL");
  }
  return value;
}

/** A WebAuthn RP id: a bare, lower-case domain name, with no scheme, port or path. */
const RP_ID =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function readRpId(key: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new ConfigError(`${key} is required`);
  }
  if (!RP_ID.test(value)) {
    throw new ConfigError(`${key} must be a bare lower-case domain name, got "${value}"`);
  }
  return value;
}

/**
 * The origins a login ceremony may come from. Each must be served from the RP
 * id or a subdomain of it, over HTTPS unless it is `localhost`.
 */
function readOrigins(key: string, value: string | undefined, rpId: string): readonly string[] {
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${key} is required: a comma-separated list of origins`);
  }
  return value.split(",").map((entry) => {
    let url: URL;
    try {
      url = new URL(entry.trim());
    } catch {
      throw new ConfigError(`${key}: "${entry}" is not an origin`);
    }
    if (url.origin !== entry.trim()) {
      throw new ConfigError(`${key}: "${entry}" is not an origin (no path, no trailing slash)`);
    }
    const local = url.hostname === "localhost";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new ConfigError(`${key}: "${entry}" must use https`);
    }
    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
      throw new ConfigError(`${key}: "${entry}" is not served from ${rpId} or a subdomain of it`);
    }
    return url.origin;
  });
}

const LEDGER_ENVIRONMENTS = ["development", "test", "production"] as const;

/** Required, with no default: a deployment must never fall into the development wiring by omission. */
function readLedgerEnvironment(value: string | undefined): Config["ledgerEnvironment"] {
  const found = LEDGER_ENVIRONMENTS.find((environment) => environment === value);
  if (found === undefined) {
    throw new ConfigError(
      `KIPPU_LEDGER_ENVIRONMENT is required: one of ${LEDGER_ENVIRONMENTS.join(", ")}`,
    );
  }
  return found;
}

/** The sponsor relay's base URL, when configured: an http(s) origin, optionally with a path. */
function readSponsorRelayUrl(value: string | undefined): { sponsorRelayUrl?: string } {
  if (value === undefined || value === "") return {};
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("KIPPU_SPONSOR_URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("KIPPU_SPONSOR_URL must be an http:// or https:// URL");
  }
  return { sponsorRelayUrl: value };
}

/** Refuses an environment carrying a route to any store but Kippu's own. */
export function assertNoForeignStoreCredentials(env: Environment): void {
  const refused = Object.keys(env)
    .filter((key) => env[key] !== undefined)
    .filter((key) => LIBPQ_VARIABLE.test(key) || LEDGER_STORE_VARIABLE.test(key))
    .sort();
  if (refused.length > 0) {
    throw new ConfigError(
      `refusing to start with ${refused.join(", ")} set: the Kippu store is configured by ` +
        "KIPPU_DATABASE_URL alone, and kippu-api holds no route to the ledger service's store " +
        "(REQ-SDK-9)",
    );
  }
}

/** Only what reaching the Kippu store needs, for tools such as the migration runner. */
export function loadStoreConfig(env: Environment = process.env): Pick<Config, "databaseUrl"> {
  assertNoForeignStoreCredentials(env);
  return { databaseUrl: readDatabaseUrl(env.KIPPU_DATABASE_URL) };
}

export function loadConfig(env: Environment = process.env): Config {
  assertNoForeignStoreCredentials(env);
  const loginRpId = readRpId("KIPPU_LOGIN_RP_ID", env.KIPPU_LOGIN_RP_ID);
  const holderRpId = readRpId("KIPPU_HOLDER_RP_ID", env.KIPPU_HOLDER_RP_ID);
  if (loginRpId === holderRpId) {
    throw new ConfigError(
      "KIPPU_LOGIN_RP_ID must differ from KIPPU_HOLDER_RP_ID: an organiser login passkey must " +
        "never be bound to the holder credential's RP id",
    );
  }
  return {
    host: env.HOST === undefined || env.HOST === "" ? DEFAULT_HOST : env.HOST,
    port: readPort(env.PORT),
    databaseUrl: readDatabaseUrl(env.KIPPU_DATABASE_URL),
    login: {
      id: loginRpId,
      origins: readOrigins("KIPPU_LOGIN_ORIGINS", env.KIPPU_LOGIN_ORIGINS, loginRpId),
    },
    holderRpId,
    ledgerEnvironment: readLedgerEnvironment(env.KIPPU_LEDGER_ENVIRONMENT),
    ...readSponsorRelayUrl(env.KIPPU_SPONSOR_URL),
  };
}
