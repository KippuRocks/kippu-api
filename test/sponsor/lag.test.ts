import { kmsP256Signer, verifySponsorship } from "@kippurocks/sponsorship";
import { softwareKmsP256Key } from "@kippurocks/sponsorship/testing";
import { createProfileV0, encodeSignedCommand } from "@ticketto/profile-v0";
import type {
  Command,
  Cursor,
  EventId,
  OperationId,
  SignedCommand,
  Signer,
  TicketId,
  Timestamp,
} from "@ticketto/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ledgerFactsProjection } from "../../src/derived/ledger-facts.js";
import { createDerivedReader } from "../../src/derived/reader.js";
import { connectRelayDerivedCopy, type RelayDerivedCopy } from "../../src/sponsor/derived.js";
import { createEntitlements, type Entitlements } from "../../src/sponsor/entitlements.js";
import { buildSponsorRelay } from "../../src/sponsor/relay.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import {
  classId,
  HOLDER_RP_ID,
  type MemoryLedger,
  memoryLedger,
  settled,
  zoneId,
} from "../support/memory-ledger.js";
import { relayLoginRole } from "../support/sponsor-relay.js";

const profile = createProfileV0({ rpId: HOLDER_RP_ID });
const zone = zoneId(0x51);
let operation = 0;

async function transfer(
  holder: Signer,
  event: EventId,
  ticket: TicketId,
  receiver: Signer,
): Promise<SignedCommand> {
  operation += 1;
  const command: Command = {
    kind: "transferTicket",
    operationId: operation.toString(16).padStart(32, "0") as OperationId,
    expiresAt: 4_000_000_000_000 as Timestamp,
    event,
    ticket,
    receiver: receiver.account,
  };
  return { command, authorisation: await holder.sign(profile.encodeCommand(command)) };
}

/** Issues a ticket directly on the ledger, and returns it with its receipt cursor. */
async function issue(ledger: MemoryLedger, event: EventId, discriminator: number, holder: Signer) {
  const issued = ledger.direct.issueTicket(ledger.organiser.signer, {
    event,
    zone,
    placement: {
      kind: "Unseated",
      discriminator: discriminator.toString(16).padStart(32, "0") as never,
    },
    class: classId(0xc1),
    provenance: "Purchased",
    policy: { kind: "Single" },
    restrictions: { cannotResale: false, cannotTransfer: false },
    holder: holder.account,
    metadata: null,
  });
  const receipt = await settled(issued.submission);
  return { ticket: issued.id, cursor: receipt.cursor };
}

describeWithStore("lag-aware sponsorship (REQ-SP-5, NFR-11)", () => {
  const ledger = memoryLedger();
  const sponsor = kmsP256Signer(softwareKmsP256Key());
  let database: TestDatabase;
  let role: Awaited<ReturnType<typeof relayLoginRole>>;
  let derived: RelayDerivedCopy;
  let relay: FastifyInstance;
  let alice: Signer;
  let bob: Signer;
  let event: EventId;

  const catchUp = () =>
    createDerivedReader({
      store: database.store,
      log: ledger.kippu.log,
      projections: [ledgerFactsProjection(ledger.kippu)],
      onError: () => {},
    }).catchUp();

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    await ledger.registerOrganiser();
    alice = await ledger.registerHolder(0x21);
    bob = await ledger.registerHolder(0x22);
    event = await ledger.createEvent(0x01, [zone]);
    await catchUp();
    role = await relayLoginRole(database.url);
    derived = connectRelayDerivedCopy(role.url);
    relay = buildSponsorRelay({
      sponsor,
      derived,
      entitlements: createEntitlements({
        derived: derived.queries,
        organisers: derived.organisers,
        profile: createProfileV0({ rpId: "holder.kippu.example" }),
        registrationRateLimit: { registrations: 5, window: 60_000 },
      }),
      lagWait: 3_000,
    });
  });

  afterAll(async () => {
    await relay?.close();
    await derived?.close();
    await role?.drop();
    await database?.drop();
  });

  const sponsorRequest = (input: SignedCommand, after?: Cursor) =>
    relay.inject({
      method: "POST",
      url: "/v0/sponsor",
      payload: {
        input: { kind: "command", bytes: Buffer.from(encodeSignedCommand(input)).toString("hex") },
        ...(after === undefined ? {} : { after }),
      },
    });

  it("REQ-SP-5: a transfer signed immediately after receipt is sponsored once the copy catches up", async () => {
    const { ticket, cursor } = await issue(ledger, event, 0x01, alice);
    const signed = await transfer(alice, event, ticket, bob);

    // The copy has not read the issuance yet.
    expect((await derived.queries.ticket(ticket)).result).toBeNull();
    const pending = sponsorRequest(signed, cursor);
    setTimeout(() => void catchUp(), 300);
    const response = await pending;

    expect(response.statusCode, response.body).toBe(200);
    const sponsorship = Uint8Array.from(Buffer.from(response.json().sponsorship, "hex"));
    expect(verifySponsorship(sponsorship, signed, { sponsors: [sponsor.account] }).ok).toBe(true);
  });

  it("REQ-SP-5: a holder whose registration the copy has not read yet is sponsored once it catches up, never refused", async () => {
    // A new holder registers and is issued a ticket directly on the ledger; the
    // relay's copy has read neither when their first transfer asks for sponsorship.
    const carol = await ledger.registerHolder(0x23);
    const { ticket, cursor } = await issue(ledger, event, 0x06, carol);
    const signed = await transfer(carol, event, ticket, bob);

    expect((await derived.queries.credentials(carol.account)).result).toEqual([]);
    const lagging = await sponsorRequest(signed, cursor);
    expect(lagging.statusCode, lagging.body).toBe(503);
    expect(lagging.json().error.code).toBe("lagging");

    const pending = sponsorRequest(signed, cursor);
    setTimeout(() => void catchUp(), 300);
    const response = await pending;
    expect(response.statusCode, response.body).toBe(200);
  }, 30_000);

  it("REQ-SP-5: a copy that has not caught up in time is answered as lagging, never refused", async () => {
    const { ticket, cursor } = await issue(ledger, event, 0x02, alice);
    const signed = await transfer(alice, event, ticket, bob);
    const started = Date.now();
    const response = await sponsorRequest(signed, cursor);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json().error.code).toBe("lagging");

    await catchUp();
    const retried = await sponsorRequest(signed, cursor);
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it("a refusal from a copy that already reflects the receipt cursor is final, and immediate", async () => {
    const { ticket, cursor } = await issue(ledger, event, 0x03, alice);
    await catchUp();
    const notTheHolder = await transfer(bob, event, ticket, alice);
    const started = Date.now();
    const response = await sponsorRequest(notTheHolder, cursor);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ERR-SponsorshipRefused");
  });

  it("without a receipt cursor, a refusal is immediate", async () => {
    const { ticket } = await issue(ledger, event, 0x04, alice);
    const response = await sponsorRequest(await transfer(alice, event, ticket, bob));
    expect(response.statusCode).toBe(403);
    await catchUp();
  });

  it("refuses a malformed receipt cursor", async () => {
    const { ticket } = await issue(ledger, event, 0x05, alice);
    await catchUp();
    const response = await sponsorRequest(
      await transfer(alice, event, ticket, bob),
      "a b" as Cursor,
    );
    expect(response.statusCode).toBe(400);
  });
});

describe("lag-aware sponsorship, without a database", () => {
  it("REQ-SP-5: a refusal read just before the reader commits the receipt's batch is decided again, not final", async () => {
    // The first decision reads the copy before the batch lands; by the time the
    // relay checks the cursor, the copy already reflects it.
    let decisions = 0;
    const entitlements: Entitlements = {
      decide: async () => {
        decisions += 1;
        return decisions === 1
          ? { entitled: false, reason: "no ticket in the derived copy" }
          : { entitled: true, entitlement: { kind: "accountCreation", account: "00" as never } };
      },
    };
    const derived = {
      queries: {} as RelayDerivedCopy["queries"],
      organisers: { isOrganiserAccount: async () => false },
      current: async () => ({ cursor: "7" as Cursor, records: 8, lastRecordedAt: 0 }),
      waitFor: async () => true,
      close: async () => {},
    } satisfies RelayDerivedCopy;
    const relay = buildSponsorRelay({
      sponsor: kmsP256Signer(softwareKmsP256Key()),
      derived,
      entitlements,
      lagWait: 1_000,
    });
    const alice = (await import("@ticketto/profile-v0/testing")).softwareP256Signer().signer;
    const signed = await transfer(
      alice,
      "01".repeat(32) as EventId,
      "02".repeat(32) as TicketId,
      alice,
    );
    try {
      const response = await relay.inject({
        method: "POST",
        url: "/v0/sponsor",
        payload: {
          input: {
            kind: "command",
            bytes: Buffer.from(encodeSignedCommand(signed)).toString("hex"),
          },
          after: "7",
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(decisions).toBe(2);
    } finally {
      await relay.close();
    }
  });
});
