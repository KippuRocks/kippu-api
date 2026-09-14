import type { AddressInfo } from "node:net";
import { kmsP256Signer } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import type { Cursor, Discriminator, Receipt, Result, ZoneId } from "@ticketto/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";
import { connectRelayDerivedCopy, type RelayDerivedCopy } from "../../src/sponsor/derived.js";
import { createEntitlements } from "../../src/sponsor/entitlements.js";
import { buildSponsorRelay } from "../../src/sponsor/relay.js";
import { createServer, type KippuServer } from "../../src/wiring.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { classId } from "../support/memory-ledger.js";
import { relayLoginRole } from "../support/sponsor-relay.js";

const environment = (databaseUrl: string, extra: Record<string, string> = {}) => ({
  KIPPU_DATABASE_URL: databaseUrl,
  KIPPU_LOGIN_RP_ID: "login.kippu.example",
  KIPPU_LOGIN_ORIGINS: "https://ibento.login.kippu.example",
  KIPPU_HOLDER_RP_ID: "holder.kippu.example",
  KIPPU_LEDGER_ENVIRONMENT: "development",
  ...extra,
});

describe("sponsor configuration", () => {
  it("uses the development sponsor unless KIPPU_SPONSOR_URL names the relay", () => {
    const url = "postgres://kippu_api:x@127.0.0.1:1/kippu_api";
    expect(loadConfig(environment(url)).sponsorRelayUrl).toBeUndefined();
    expect(
      loadConfig(environment(url, { KIPPU_SPONSOR_URL: "http://127.0.0.1:8082" })).sponsorRelayUrl,
    ).toBe("http://127.0.0.1:8082");
    for (const bad of ["relay", "ftp://relay.example"]) {
      expect(() => loadConfig(environment(url, { KIPPU_SPONSOR_URL: bad }))).toThrow(ConfigError);
    }
  });
});

async function settled(submission: PromiseLike<Result<Receipt>>): Promise<Receipt> {
  const result = await submission;
  if (!result.ok) expect.fail(`${result.error.code} ${result.error.detail ?? ""}`);
  return result.value;
}

describeWithStore("the server sponsored through the relay", () => {
  let database: TestDatabase;
  let role: Awaited<ReturnType<typeof relayLoginRole>>;
  let derived: RelayDerivedCopy;
  let relay: FastifyInstance;
  let server: KippuServer;
  const received: { bytes: string; after?: Cursor }[] = [];

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    role = await relayLoginRole(database.url);
    derived = connectRelayDerivedCopy(role.url);
    relay = buildSponsorRelay({
      sponsor: kmsP256Signer(softwareKmsP256Key()),
      derived,
      entitlements: createEntitlements({
        derived: derived.queries,
        registrationRateLimit: { registrations: 5, window: 60_000 },
      }),
      lagWait: 20_000,
    });
    relay.addHook("preHandler", async (request) => {
      const body = request.body as { input: { bytes: string }; after?: Cursor };
      received.push({
        bytes: body.input.bytes,
        ...(body.after === undefined ? {} : { after: body.after }),
      });
    });
    await relay.listen({ host: "127.0.0.1", port: 0 });
    const relayUrl = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;

    server = createServer(
      loadConfig(environment(database.url, { KIPPU_SPONSOR_URL: relayUrl })),
      database.store,
    );
    server.start();
  });

  afterAll(async () => {
    await server?.close();
    await relay?.close();
    await derived?.close();
    await role?.drop();
    await database?.drop();
  });

  it("REQ-SP-1, REQ-SP-5: every write goes through the relay, carrying the latest receipt cursor", {
    timeout: 60_000,
  }, async () => {
    const { ledger } = server;
    const organiser = softwareP256Signer();
    const zone = "51".repeat(32) as ZoneId;

    const registered = await settled(
      ledger.registerCredential(organiser.signer, {
        account: organiser.signer.account,
        registration: organiser.registration,
      }),
    );
    const created = ledger.createEvent(organiser.signer, {
      salt: new Uint8Array(16).fill(1),
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
      metadata: null,
    });
    const event = await settled(created.submission);
    // Issued at once: the relay's copy may not have read the event yet, and it
    // waits for the cursor the server sends rather than refusing.
    await settled(
      ledger.issueTicket(organiser.signer, {
        event: created.id,
        zone,
        placement: { kind: "Unseated", discriminator: "01".repeat(16) as Discriminator },
        class: classId(0xc1),
        provenance: "Granted",
        policy: { kind: "Single" },
        restrictions: { cannotResale: false, cannotTransfer: false },
        holder: organiser.signer.account,
        metadata: null,
      }).submission,
    );

    const inputs = [...new Map(received.map((request) => [request.bytes, request])).values()];
    expect(inputs).toHaveLength(3);
    expect(inputs[0]?.after).toBeUndefined();
    expect(inputs[1]?.after).toBe(registered.cursor);
    expect(inputs[2]?.after).toBe(event.cursor);
  });

  it("ERR-SponsorshipRefused: a write outside every entitlement is refused by the relay", {
    timeout: 60_000,
  }, async () => {
    const stranger = softwareP256Signer();
    const result = await server.ledger.setEventStatus(stranger.signer, {
      event: "ee".repeat(32) as never,
      status: "Sealed",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ERR-SponsorshipRefused" } });
  });
});
