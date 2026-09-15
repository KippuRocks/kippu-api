import { readFile } from "node:fs/promises";
import { kmsP256Signer } from "@kippurocks/sponsorship";
import { softwareKmsP256Key } from "@kippurocks/sponsorship/testing";
import { createProfileV0 } from "@ticketto/profile-v0";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config.js";
import { loadSponsorRelayConfig } from "../../src/sponsor/config.js";
import { connectRelayDerivedCopy, type RelayDerivedCopy } from "../../src/sponsor/derived.js";
import { createEntitlements } from "../../src/sponsor/entitlements.js";
import { buildSponsorRelay } from "../../src/sponsor/relay.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { memoryLedger, zoneId } from "../support/memory-ledger.js";
import { catchUpDerivedCopy, relayLoginRole } from "../support/sponsor-relay.js";

const SECRET = "11".repeat(32);
const registrationRateLimit = { registrations: 3, window: 3_600_000 };
const base = {
  KIPPU_SPONSOR_ENVIRONMENT: "test",
  KIPPU_SPONSOR_DERIVED_DATABASE_URL: "postgres://relay:secret@127.0.0.1:5432/kippu_api",
  KIPPU_SPONSOR_SOFTWARE_SECRET_KEY: SECRET,
  KIPPU_SPONSOR_REGISTRATIONS_PER_WINDOW: "3",
  KIPPU_SPONSOR_REGISTRATION_WINDOW_SECONDS: "3600",
  KIPPU_SPONSOR_LAG_WAIT_MS: "5000",
  KIPPU_SPONSOR_HOLDER_RP_ID: "holder.kippu.example",
};

describe("sponsor relay configuration", () => {
  it("reads its own derived-copy credentials, where to listen, and the software sponsor key", () => {
    const config = loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_PORT: "9200" });
    expect(config).toMatchObject({
      environment: "test",
      host: "0.0.0.0",
      port: 9200,
      derivedDatabaseUrl: base.KIPPU_SPONSOR_DERIVED_DATABASE_URL,
      registrationRateLimit: { registrations: 3, window: 3_600_000 },
      lagWait: 5000,
      holderRpId: "holder.kippu.example",
    });
    expect(() =>
      loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_HOLDER_RP_ID: "https://holder.example" }),
    ).toThrow(/KIPPU_SPONSOR_HOLDER_RP_ID/);
    expect(Buffer.from(config.softwareSecretKey).toString("hex")).toBe(SECRET);
    expect(loadSponsorRelayConfig(base).port).toBe(8082);
  });

  it("NFR-4: is never given kippu-api's store credentials, nor a route to the ledger's store", () => {
    expect(() =>
      loadSponsorRelayConfig({ ...base, KIPPU_DATABASE_URL: "postgres://kippu_api@h/kippu_api" }),
    ).toThrow(/KIPPU_DATABASE_URL/);
    expect(() => loadSponsorRelayConfig({ ...base, PGPASSWORD: "x" })).toThrow(ConfigError);
    expect(() =>
      loadSponsorRelayConfig({ ...base, TICKETTO_DATABASE_URL: "postgres://ledger@h/ledger" }),
    ).toThrow(ConfigError);
  });

  it("refuses production until a KMS provider is chosen, and a malformed software key", () => {
    expect(() =>
      loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_ENVIRONMENT: "production" }),
    ).toThrow(/KMS/);
    expect(() =>
      loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_SOFTWARE_SECRET_KEY: "11" }),
    ).toThrow(ConfigError);
    expect(() => loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_ENVIRONMENT: "staging" })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_DERIVED_DATABASE_URL: "" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_REGISTRATIONS_PER_WINDOW: "" }),
    ).toThrow(/KIPPU_SPONSOR_REGISTRATIONS_PER_WINDOW/);
    expect(() =>
      loadSponsorRelayConfig({ ...base, KIPPU_SPONSOR_REGISTRATION_WINDOW_SECONDS: "0" }),
    ).toThrow(ConfigError);
  });
});

/**
 * The relay's module graph, from its entry point, by static imports: it must
 * reach the derived copy's queries and nothing of kippu-api's business layer —
 * no application, router, session, organiser authority, SDK factory or class.
 */
async function moduleGraph(entry: URL): Promise<Set<string>> {
  const root = new URL("../../", import.meta.url);
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as URL;
    const relative = file.pathname.slice(root.pathname.length);
    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      pending.push(new URL((match[1] as string).replace(/\.js$/, ".ts"), file));
    }
  }
  return seen;
}

describe("sponsor relay process", () => {
  it("AD-18: shares no module with kippu-api's business layer", async () => {
    const graph = await moduleGraph(new URL("../../src/sponsor/server.ts", import.meta.url));
    const allowed = [
      /^src\/sponsor\//,
      /^src\/derived\/(queries|freshness|reader|projection)\.ts$/,
      /^src\/store\/store\.ts$/,
      /^src\/config\.ts$/,
    ];
    const outside = [...graph].filter((file) => !allowed.some((pattern) => pattern.test(file)));
    expect(outside).toEqual([]);
    expect(graph).toContain("src/derived/queries.ts");
  });
});

describeWithStore("sponsor relay with the derived copy", () => {
  let database: TestDatabase;
  let role: Awaited<ReturnType<typeof relayLoginRole>>;
  let derived: RelayDerivedCopy;
  const ledger = memoryLedger();
  let event: string;
  let ticket: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    await ledger.registerOrganiser();
    const holder = await ledger.registerHolder(0x21);
    const zone = zoneId(0x51);
    event = await ledger.createEvent(0x01, [zone]);
    ticket = await ledger.issue(event as never, zone, 0x01, holder.account);
    await catchUpDerivedCopy(database.store, ledger);
    role = await relayLoginRole(database.url);
    derived = connectRelayDerivedCopy(role.url);
  });

  afterAll(async () => {
    await derived?.close();
    await role?.drop();
    await database?.drop();
  });

  it("NFR-4: starts and serves with kippu-api stopped, reading the derived copy with its own role", async () => {
    const sponsor = kmsP256Signer(softwareKmsP256Key());
    const relay = buildSponsorRelay({
      sponsor,
      derived,
      entitlements: createEntitlements({
        derived: derived.queries,
        organisers: derived.organisers,
        profile: createProfileV0({ rpId: "holder.kippu.example" }),
        registrationRateLimit,
      }),
      lagWait: 1_000,
    });
    try {
      const response = await relay.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ status: "ok", sponsor: sponsor.account });
      expect(body.derived.records).toBeGreaterThan(0);
    } finally {
      await relay.close();
    }
    const read = await derived.queries.ticket(ticket as never);
    expect(read.result?.value.event).toBe(event);
  });

  it("reads ledger facts only: kippu-api's own tables are out of reach", async () => {
    const pool = (await import("pg")).default.Pool;
    const client = new pool({ connectionString: role.url });
    try {
      // Organiser account ids, through their view, are the one thing outside the copy it reads.
      await expect(
        client.query("SELECT account FROM sponsor_relay_organiser_accounts LIMIT 1"),
      ).resolves.toBeDefined();
      await expect(
        client.query("SELECT organiser_id FROM sponsor_relay_organiser_accounts LIMIT 1"),
      ).rejects.toMatchObject({ code: "42703" });
      for (const table of ["organisers", "sessions", "audit_log", "organiser_ledger_accounts"]) {
        await expect(client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toMatchObject({
          code: "42501",
        });
      }
    } finally {
      await client.end();
    }
  });

  it("writes nothing: its role holds no write privilege, and its transactions are read only", async () => {
    const pool = (await import("pg")).default.Pool;
    const asRole = new pool({ connectionString: role.url });
    try {
      await expect(
        asRole.query("UPDATE derived_events SET status = 'Cancelled' WHERE id = $1", [event]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await asRole.end();
    }
    // Even given credentials that could write, the relay's connections cannot.
    const privileged = connectRelayDerivedCopy(database.url);
    try {
      const current = await privileged.current();
      expect(current.records).toBeGreaterThan(0);
      const probe = (await import("pg")).default;
      const client = new probe.Client({
        connectionString: database.url,
        options: "-c default_transaction_read_only=on",
      });
      await client.connect();
      try {
        await expect(
          client.query("UPDATE derived_events SET status = 'Cancelled' WHERE id = $1", [event]),
        ).rejects.toMatchObject({ code: "25006" });
      } finally {
        await client.end();
      }
    } finally {
      await privileged.close();
    }
  });

  it("answers 503 on /health when the derived copy cannot be read", async () => {
    const unreachable = connectRelayDerivedCopy("postgres://nobody:nothing@127.0.0.1:1/none");
    const relay = buildSponsorRelay({
      sponsor: kmsP256Signer(softwareKmsP256Key()),
      derived: unreachable,
      entitlements: createEntitlements({
        derived: unreachable.queries,
        organisers: unreachable.organisers,
        profile: createProfileV0({ rpId: "holder.kippu.example" }),
        registrationRateLimit,
      }),
      lagWait: 1_000,
    });
    try {
      const response = await relay.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
    } finally {
      await relay.close();
      await unreachable.close();
    }
  });
});
