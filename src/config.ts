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

export function loadConfig(env: Environment = process.env): Config {
  assertNoForeignStoreCredentials(env);
  return {
    host: env.HOST === undefined || env.HOST === "" ? DEFAULT_HOST : env.HOST,
    port: readPort(env.PORT),
    databaseUrl: readDatabaseUrl(env.KIPPU_DATABASE_URL),
  };
}
