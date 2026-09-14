/**
 * The sponsor relay's configuration, read from the environment (`F-023` plan
 * §5.1).
 *
 * The relay is a separate process from kippu-api's business layer, with its own
 * minimal read access to the derived copy and nothing else. It is never given
 * kippu-api's store credentials, and no route to the ledger service's store.
 */
import { assertNoForeignStoreCredentials, ConfigError, type Environment } from "../config.js";

/** Where the relay runs. A software sponsor key is refused in production. */
export type SponsorRelayEnvironment = "development" | "test" | "production";

const ENVIRONMENTS: readonly SponsorRelayEnvironment[] = ["development", "test", "production"];

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8082;

export interface SponsorRelayConfig {
  readonly environment: SponsorRelayEnvironment;
  readonly host: string;
  readonly port: number;
  /**
   * The derived copy, reached with the relay's own credentials: a login role
   * granted `kippu_sponsor_relay_reader` and nothing else.
   */
  readonly derivedDatabaseUrl: string;
  /**
   * The sponsor's `p256` secret key, for the software stand-in of its KMS key.
   * Only in development and test.
   */
  readonly softwareSecretKey: Uint8Array;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function readPort(value: string | undefined): number {
  if (!present(value)) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(
      `KIPPU_SPONSOR_PORT must be an integer between 0 and 65535, got "${value}"`,
    );
  }
  return port;
}

function readDatabaseUrl(value: string | undefined): string {
  if (!present(value)) {
    throw new ConfigError(
      "KIPPU_SPONSOR_DERIVED_DATABASE_URL is required: the derived copy, with the relay's own " +
        "read-only credentials",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("KIPPU_SPONSOR_DERIVED_DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError(
      "KIPPU_SPONSOR_DERIVED_DATABASE_URL must be a postgres:// or postgresql:// URL",
    );
  }
  return value;
}

function readEnvironment(value: string | undefined): SponsorRelayEnvironment {
  if (!present(value)) {
    throw new ConfigError(
      `KIPPU_SPONSOR_ENVIRONMENT is required: one of ${ENVIRONMENTS.join(", ")}`,
    );
  }
  const environment = ENVIRONMENTS.find((candidate) => candidate === value);
  if (environment === undefined) {
    throw new ConfigError(
      `KIPPU_SPONSOR_ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}, got "${value}"`,
    );
  }
  return environment;
}

function readSoftwareSecretKey(environment: SponsorRelayEnvironment, value: string | undefined) {
  if (environment === "production") {
    throw new ConfigError(
      "no KMS provider is chosen for the sponsor key; the sponsor relay cannot sponsor in " +
        "production",
    );
  }
  if (!present(value) || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ConfigError(
      "KIPPU_SPONSOR_SOFTWARE_SECRET_KEY is required outside production: the sponsor's P-256 " +
        "secret key as 64 lower-case hex characters, for the software stand-in of its KMS key",
    );
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function loadSponsorRelayConfig(env: Environment = process.env): SponsorRelayConfig {
  assertNoForeignStoreCredentials(env);
  if (present(env.KIPPU_DATABASE_URL)) {
    throw new ConfigError(
      "refusing to start with KIPPU_DATABASE_URL set: the sponsor relay reads the derived copy " +
        "with its own read-only credentials (KIPPU_SPONSOR_DERIVED_DATABASE_URL), never " +
        "kippu-api's",
    );
  }
  const environment = readEnvironment(env.KIPPU_SPONSOR_ENVIRONMENT);
  return {
    environment,
    host: present(env.KIPPU_SPONSOR_HOST) ? env.KIPPU_SPONSOR_HOST : DEFAULT_HOST,
    port: readPort(env.KIPPU_SPONSOR_PORT),
    derivedDatabaseUrl: readDatabaseUrl(env.KIPPU_SPONSOR_DERIVED_DATABASE_URL),
    softwareSecretKey: readSoftwareSecretKey(environment, env.KIPPU_SPONSOR_SOFTWARE_SECRET_KEY),
  };
}
