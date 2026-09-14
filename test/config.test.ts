import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const url = "postgres://kippu_api:secret@127.0.0.1:54329/kippu_api";

describe("configuration", () => {
  it("reads the Kippu store's URL, host and port", () => {
    expect(loadConfig({ KIPPU_DATABASE_URL: url, PORT: "9000", HOST: "127.0.0.1" })).toEqual({
      host: "127.0.0.1",
      port: 9000,
      databaseUrl: url,
    });
  });

  it("requires the Kippu store's URL", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ KIPPU_DATABASE_URL: "mysql://x" })).toThrow(ConfigError);
  });

  it("REQ-SDK-9: holds only the Kippu store, and no key for the ledger service's store", () => {
    const config = loadConfig({ KIPPU_DATABASE_URL: url });
    expect(Object.keys(config).sort()).toEqual(["databaseUrl", "host", "port"]);
  });

  it.each([
    "LEDGER_DATABASE_URL",
    "TICKETTO_OFFCHAIN_DATABASE_URL",
    "TICKETTO_OFFCHAIN_PG_PASSWORD",
    "LEDGER_STORE_POSTGRES_URL",
  ])("REQ-SDK-9: refuses to start with %s set", (key) => {
    expect(() => loadConfig({ KIPPU_DATABASE_URL: url, [key]: "postgres://ledger" })).toThrow(
      /REQ-SDK-9/,
    );
  });

  it.each(["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"])(
    "refuses libpq's %s, which would reach the driver without passing through configuration",
    (key) => {
      expect(() => loadConfig({ KIPPU_DATABASE_URL: url, [key]: "x" })).toThrow(ConfigError);
    },
  );

  it.each(["compose.yaml", ".github/workflows/ci.yml", "Dockerfile"])(
    "REQ-SDK-9: %s names no credentials for the ledger service's store",
    async (file) => {
      const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(text).not.toMatch(/\b(LEDGER|TICKETTO)[A-Z0-9_]*_(DATABASE|DB|PG|POSTGRES)/);
      expect(text).not.toMatch(/ticketto[-_]offchain[^\n]*(postgres|DATABASE_URL)/i);
    },
  );
});
