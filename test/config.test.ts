import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadStoreConfig } from "../src/config.js";

const url = "postgres://kippu_api:secret@127.0.0.1:54329/kippu_api";

/** Placeholder hostnames: the real ones are not chosen yet. */
const base = {
  KIPPU_DATABASE_URL: url,
  KIPPU_LOGIN_RP_ID: "login.kippu.example",
  KIPPU_LOGIN_ORIGINS: "https://ibento.login.kippu.example,https://login.kippu.example",
  KIPPU_HOLDER_RP_ID: "holder.kippu.example",
};

describe("configuration", () => {
  it("reads the Kippu store's URL, host and port", () => {
    expect(loadConfig({ ...base, PORT: "9000", HOST: "127.0.0.1" })).toEqual({
      host: "127.0.0.1",
      port: 9000,
      databaseUrl: url,
      login: {
        id: "login.kippu.example",
        origins: ["https://ibento.login.kippu.example", "https://login.kippu.example"],
      },
      holderRpId: "holder.kippu.example",
    });
  });

  it("the migration runner needs only the Kippu store, and refuses foreign store credentials", () => {
    expect(loadStoreConfig({ KIPPU_DATABASE_URL: url })).toEqual({ databaseUrl: url });
    expect(() => loadStoreConfig({ KIPPU_DATABASE_URL: url, PGPASSWORD: "x" })).toThrow(
      ConfigError,
    );
  });

  it("requires the Kippu store's URL", () => {
    expect(() => loadConfig({ ...base, KIPPU_DATABASE_URL: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, KIPPU_DATABASE_URL: "mysql://x" })).toThrow(ConfigError);
  });

  it("REQ-SDK-9: holds only the Kippu store, and no key for the ledger service's store", () => {
    const config = loadConfig(base);
    expect(Object.keys(config).sort()).toEqual([
      "databaseUrl",
      "holderRpId",
      "host",
      "login",
      "port",
    ]);
  });

  it.each([
    "LEDGER_DATABASE_URL",
    "TICKETTO_OFFCHAIN_DATABASE_URL",
    "TICKETTO_OFFCHAIN_PG_PASSWORD",
    "LEDGER_STORE_POSTGRES_URL",
  ])("REQ-SDK-9: refuses to start with %s set", (key) => {
    expect(() => loadConfig({ ...base, [key]: "postgres://ledger" })).toThrow(/REQ-SDK-9/);
  });

  it.each(["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"])(
    "refuses libpq's %s, which would reach the driver without passing through configuration",
    (key) => {
      expect(() => loadConfig({ ...base, [key]: "x" })).toThrow(ConfigError);
    },
  );

  it("refuses to start when the login RP id equals the holder credential's RP id", () => {
    expect(() => loadConfig({ ...base, KIPPU_HOLDER_RP_ID: "login.kippu.example" })).toThrow(
      /must differ/,
    );
  });

  it("requires both RP ids, as bare domain names", () => {
    expect(() => loadConfig({ ...base, KIPPU_LOGIN_RP_ID: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, KIPPU_HOLDER_RP_ID: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, KIPPU_LOGIN_RP_ID: "https://login.kippu.example" })).toThrow(
      ConfigError,
    );
  });

  it.each([
    ["an origin on another domain", "https://ibento.elsewhere.example"],
    ["plain http off localhost", "http://login.kippu.example"],
    ["a path", "https://login.kippu.example/app"],
  ])("refuses a login origin with %s", (_, origin) => {
    expect(() => loadConfig({ ...base, KIPPU_LOGIN_ORIGINS: origin })).toThrow(ConfigError);
  });

  it("accepts http on localhost for local development", () => {
    const config = loadConfig({
      ...base,
      KIPPU_LOGIN_RP_ID: "localhost",
      KIPPU_LOGIN_ORIGINS: "http://localhost:5173",
    });
    expect(config.login).toEqual({ id: "localhost", origins: ["http://localhost:5173"] });
  });

  it.each(["compose.yaml", ".github/workflows/ci.yml", "Dockerfile"])(
    "REQ-SDK-9: %s names no credentials for the ledger service's store",
    async (file) => {
      const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(text).not.toMatch(/\b(LEDGER|TICKETTO)[A-Z0-9_]*_(DATABASE|DB|PG|POSTGRES)/);
      expect(text).not.toMatch(/ticketto[-_]offchain[^\n]*(postgres|DATABASE_URL)/i);
    },
  );
});
