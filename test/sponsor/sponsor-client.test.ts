import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createRelaySponsor, kmsP256Signer } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import type {
  Cursor,
  Discriminator,
  Receipt,
  Submission,
  SubmissionState,
  ZoneId,
} from "@ticketto/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedReader, type DerivedReader } from "../../src/derived/reader.js";
import { type KippuTicketto, makeTicketto } from "../../src/ledger/ticketto.js";
import { connectRelayDerivedCopy, type RelayDerivedCopy } from "../../src/sponsor/derived.js";
import { createEntitlements } from "../../src/sponsor/entitlements.js";
import { buildSponsorRelay } from "../../src/sponsor/relay.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { classId, HOLDER_RP_ID } from "../support/memory-ledger.js";
import { relayLoginRole } from "../support/sponsor-relay.js";

/** Words for a fee, a balance or a funding step, which no client flow may show (`REQ-SP-1a`). */
const FEE_VOCABULARY = /\b(fees?|gas|balances?|top[\s_-]?ups?|topUp|fund(s|ing)?|notionalCost)\b/i;

async function sourcesUnder(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => new URL(`${entry.parentPath}/${entry.name}`, "file://"));
}

it("REQ-SP-1a: no client-facing contract of kippu-api names a fee, a balance or a funding step", async () => {
  const root = new URL("../../", import.meta.url);
  const routers = (await sourcesUnder(new URL("src/", root))).filter((file) =>
    file.pathname.endsWith("/router.ts"),
  );
  const contract = [...routers, ...(await sourcesUnder(new URL("packages/api/src/", root)))];
  expect(routers.length).toBeGreaterThan(0);
  for (const file of contract) {
    const source = await readFile(file, "utf8");
    expect(source.match(FEE_VOCABULARY), file.pathname).toBeNull();
  }
});

describeWithStore("kippu-api sponsored through the relay client", () => {
  let database: TestDatabase;
  let role: Awaited<ReturnType<typeof relayLoginRole>>;
  let derived: RelayDerivedCopy;
  let relay: FastifyInstance;
  let reader: DerivedReader;
  let ticketto: KippuTicketto;
  let lastReceipt: Cursor | undefined;
  const requests: string[] = [];
  const sponsorKey = kmsP256Signer(softwareKmsP256Key());

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    role = await relayLoginRole(database.url);
    derived = connectRelayDerivedCopy(role.url);
    relay = buildSponsorRelay({
      sponsor: sponsorKey,
      derived,
      entitlements: createEntitlements({
        derived: derived.queries,
        registrationRateLimit: { registrations: 5, window: 60_000 },
      }),
      lagWait: 5_000,
    });
    await relay.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;

    ticketto = makeTicketto({
      environment: "test",
      holderRpId: HOLDER_RP_ID,
      operationLifetime: 60_000,
      sponsor: createRelaySponsor({
        url,
        receiptCursor: () => lastReceipt,
        fetch: async (input, init) => {
          requests.push(String(input));
          return fetch(input, init);
        },
      }),
    });
    reader = createDerivedReader({
      store: database.store,
      log: ticketto.log,
      projections: [ledgerFactsProjection(ticketto)],
      pollInterval: 50,
      onError: () => {},
    });
    reader.start();
  });

  afterAll(async () => {
    await reader?.stop();
    await relay?.close();
    await derived?.close();
    await role?.drop();
    await database?.drop();
  });

  /** Settles a submission, keeping its receipt cursor and every state it passed through. */
  async function settle(submission: Submission<Receipt>): Promise<SubmissionState[]> {
    const states: SubmissionState[] = [];
    for await (const state of submission) states.push(state);
    const result = await submission;
    if (!result.ok) expect.fail(`${result.error.code} ${result.error.detail ?? ""}`);
    lastReceipt = result.value.cursor;
    return states;
  }

  it("REQ-SP-1, REQ-SP-1a: every write is sponsored by the relay, and no step shows a fee", async () => {
    const organiser = softwareP256Signer();
    const zone = "51".repeat(32) as ZoneId;
    const states: SubmissionState[] = [];

    states.push(
      ...(await settle(
        ticketto.registerCredential(organiser.signer, {
          account: organiser.signer.account,
          registration: organiser.registration,
        }),
      )),
    );
    const created = ticketto.createEvent(organiser.signer, {
      salt: new Uint8Array(16).fill(1),
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
      metadata: null,
    });
    states.push(...(await settle(created.submission)));

    // Issued immediately: the relay's copy may not have read the event yet, and
    // waits for the receipt cursor rather than refusing (REQ-SP-5).
    const issued = ticketto.issueTicket(organiser.signer, {
      event: created.id,
      zone,
      placement: { kind: "Unseated", discriminator: "01".repeat(16) as Discriminator },
      class: classId(0xc1),
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      holder: softwareP256Signer().signer.account,
      metadata: null,
    });
    states.push(...(await settle(issued.submission)));

    expect(requests).toHaveLength(3);
    expect(requests.every((url) => url.endsWith("/v0/sponsor"))).toBe(true);
    expect(states.length).toBeGreaterThan(0);
    expect(JSON.stringify(states).match(FEE_VOCABULARY)).toBeNull();
  });

  it("ERR-SponsorshipRefused: an unentitled write is rejected with the relay's refusal", async () => {
    const stranger = softwareP256Signer();
    const result = await ticketto.setEventStatus(stranger.signer, {
      event: "ee".repeat(32) as never,
      status: "Sealed",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ERR-SponsorshipRefused" } });
  });
});
