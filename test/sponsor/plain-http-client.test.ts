import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { kmsP256Signer, verifySponsorship } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import { createProfileV0 } from "@ticketto/profile-v0";
import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import type { Command, EventId, OperationId, SignedCommand, Timestamp } from "@ticketto/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requestSponsorship } from "../../fixtures/sponsor-client/src/relay-client.js";
import { connectRelayDerivedCopy, type RelayDerivedCopy } from "../../src/sponsor/derived.js";
import { createEntitlements } from "../../src/sponsor/entitlements.js";
import { buildSponsorRelay } from "../../src/sponsor/relay.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { HOLDER_RP_ID } from "../support/memory-ledger.js";
import { relayLoginRole } from "../support/sponsor-relay.js";

const profile = createProfileV0({ rpId: HOLDER_RP_ID });
const fixture = new URL("../../fixtures/sponsor-client/", import.meta.url);

async function signed(
  command: Command,
  signer = softwareP256Signer().signer,
): Promise<SignedCommand> {
  return { command, authorisation: await signer.sign(profile.encodeCommand(command)) };
}

const envelope = (byte: number) => ({
  operationId: byte.toString(16).padStart(32, "0") as OperationId,
  expiresAt: 4_000_000_000_000 as Timestamp,
});

it("AD-07: the sponsor client fixture depends on neither tRPC nor kippu-api", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", fixture), "utf8"));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  expect(dependencies.sort()).toEqual(["@ticketto/profile-v0", "@ticketto/sdk"]);

  const sources = await readdir(new URL("src/", fixture));
  for (const file of sources) {
    const source = await readFile(new URL(`src/${file}`, fixture), "utf8");
    for (const [, specifier] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      expect(specifier).toMatch(/^(node:|@ticketto\/(sdk|profile-v0)(\/testing)?$|\.\/)/);
    }
  }
});

describeWithStore("the relay's plain-HTTP API", () => {
  let database: TestDatabase;
  let role: Awaited<ReturnType<typeof relayLoginRole>>;
  let derived: RelayDerivedCopy;
  let relay: FastifyInstance;
  let relayUrl: string;
  const sponsor = kmsP256Signer(softwareKmsP256Key());

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    role = await relayLoginRole(database.url);
    derived = connectRelayDerivedCopy(role.url);
    relay = buildSponsorRelay({
      sponsor,
      derived,
      entitlements: createEntitlements({
        derived: derived.queries,
        registrationRateLimit: { registrations: 5, window: 60_000 },
      }),
      lagWait: 500,
    });
    await relay.listen({ host: "127.0.0.1", port: 0 });
    relayUrl = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await relay?.close();
    await derived?.close();
    await role?.drop();
    await database?.drop();
  });

  it("AD-07: a client with no tRPC dependency obtains a sponsorship over plain HTTP", async () => {
    const credential = softwareP256Signer();
    const input = await signed(
      {
        kind: "registerCredential",
        ...envelope(1),
        account: credential.signer.account,
        registration: credential.registration,
      },
      credential.signer,
    );
    const result = await requestSponsorship(relayUrl, input);
    expect(result.status).toBe("sponsored");
    if (result.status !== "sponsored") return;
    expect(verifySponsorship(result.sponsorship, input, { sponsors: [sponsor.account] }).ok).toBe(
      true,
    );
  });

  it("ERR-SponsorshipRefused: the same client reads a refusal, and a lagging copy, as documented", async () => {
    const input = await signed({
      kind: "setEventStatus",
      ...envelope(2),
      event: "ee".repeat(32) as EventId,
      status: "Sealed",
    });
    expect(await requestSponsorship(relayUrl, input)).toMatchObject({ status: "refused" });
    expect(await requestSponsorship(relayUrl, input, "999")).toMatchObject({ status: "lagging" });
    expect(await requestSponsorship(relayUrl, input, "not a cursor")).toMatchObject({
      status: "malformed",
    });
  });
});
