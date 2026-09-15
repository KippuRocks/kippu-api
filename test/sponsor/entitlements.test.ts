import { randomBytes } from "node:crypto";
import { kmsP256Signer, type SponsoredInput, verifySponsorship } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import {
  createProfileV0,
  decodeAuthorisation,
  encodeAuthorisation,
  encodeSignedAccessPass,
  encodeSignedCommand,
  eventId,
} from "@ticketto/profile-v0";
import { simulatedWebAuthnSigner, softwareP256Signer } from "@ticketto/profile-v0/testing";
import type {
  AccessPass,
  Command,
  Discriminator,
  EventId,
  OperationId,
  PassId,
  Signer,
  TicketId,
  Timestamp,
} from "@ticketto/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectRelayDerivedCopy, type RelayDerivedCopy } from "../../src/sponsor/derived.js";
import { createEntitlements } from "../../src/sponsor/entitlements.js";
import { buildSponsorRelay } from "../../src/sponsor/relay.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { classId, HOLDER_RP_ID, memoryLedger, settled, zoneId } from "../support/memory-ledger.js";
import {
  catchUpDerivedCopy,
  recordOrganiserAccount,
  relayLoginRole,
} from "../support/sponsor-relay.js";

const profile = createProfileV0({ rpId: HOLDER_RP_ID });
const hex = (length: number, byte: number) => byte.toString(16).padStart(2, "0").repeat(length);

/** An operation envelope that has not expired. */
const envelope = () => ({
  operationId: randomBytes(16).toString("hex") as OperationId,
  expiresAt: 4_000_000_000_000 as Timestamp,
});

async function sign(signer: Signer, command: Command): Promise<SponsoredInput> {
  return { command, authorisation: await signer.sign(profile.encodeCommand(command)) };
}

async function signPass(signer: Signer, ticket: TicketId): Promise<SponsoredInput> {
  const pass: AccessPass = {
    ticket,
    holder: signer.account,
    id: randomBytes(16).toString("hex") as PassId,
    notBefore: 1_800_000_000_000 as Timestamp,
    notAfter: 1_800_000_060_000 as Timestamp,
  };
  return { pass, authorisation: await signer.sign(profile.encodePass(pass)) };
}

describeWithStore("entitlements (F-023 plan §5.3)", () => {
  const ledger = memoryLedger();
  const sponsor = kmsP256Signer(softwareKmsP256Key());
  const stranger = softwareP256Signer({ secretKey: new Uint8Array(32).fill(0x55) }).signer;
  const outsider = softwareP256Signer({ secretKey: new Uint8Array(32).fill(0x66) });
  const zone = zoneId(0x51);
  let database: TestDatabase;
  let role: Awaited<ReturnType<typeof relayLoginRole>>;
  let derived: RelayDerivedCopy;
  let relay: FastifyInstance;
  let alice: Signer;
  let bob: Signer;
  let event: EventId;
  let cancelled: EventId;
  let finished: EventId;
  let ticket: TicketId;
  let frozen: TicketId;
  let cancelledTicket: TicketId;
  let finishedTicket: TicketId;
  let clock = 1_000_000;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    await ledger.registerOrganiser();
    alice = await ledger.registerHolder(0x21);
    bob = await ledger.registerHolder(0x22);
    event = await ledger.createEvent(0x01, [zone]);
    cancelled = await ledger.createEvent(0x02, [zone]);
    finished = await ledger.createEvent(0x03, [zone]);
    ticket = await ledger.issue(event, zone, 0x01, alice.account);
    cancelledTicket = await ledger.issue(cancelled, zone, 0x02, alice.account);
    finishedTicket = await ledger.issue(finished, zone, 0x03, alice.account);
    const restricted = ledger.direct.issueTicket(ledger.organiser.signer, {
      event,
      zone,
      placement: { kind: "Unseated", discriminator: hex(16, 0x04) as Discriminator },
      class: classId(0xc2),
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
      holder: alice.account,
      metadata: null,
    });
    await settled(restricted.submission);
    frozen = restricted.id;
    await catchUpDerivedCopy(database.store, ledger);
    // Event status changes are M3 rules; the copy is set as it would project them.
    await database.store.query("UPDATE derived_events SET status = 'Cancelled' WHERE id = $1", [
      cancelled,
    ]);
    await database.store.query("UPDATE derived_events SET status = 'Finished' WHERE id = $1", [
      finished,
    ]);

    await recordOrganiserAccount(database.store, ledger.organiser.signer.account);
    // Registered on the ledger, but not a Kippu organiser account.
    await settled(
      ledger.direct.registerCredential(outsider.signer, {
        account: outsider.signer.account,
        registration: outsider.registration,
      }),
    );
    await catchUpDerivedCopy(database.store, ledger);
    role = await relayLoginRole(database.url);
    derived = connectRelayDerivedCopy(role.url);
    relay = buildSponsorRelay({
      sponsor,
      derived,
      entitlements: createEntitlements({
        derived: derived.queries,
        organisers: derived.organisers,
        profile: createProfileV0({ rpId: "holder.kippu.example" }),
        registrationRateLimit: { registrations: 2, window: 60_000 },
        now: () => clock,
      }),
      lagWait: 1_000,
    });
  });

  afterAll(async () => {
    await relay?.close();
    await derived?.close();
    await role?.drop();
    await database?.drop();
  });

  async function request(input: SponsoredInput) {
    const bytes = "command" in input ? encodeSignedCommand(input) : encodeSignedAccessPass(input);
    return relay.inject({
      method: "POST",
      url: "/v0/sponsor",
      payload: {
        input: {
          kind: "command" in input ? "command" : "pass",
          bytes: Buffer.from(bytes).toString("hex"),
        },
      },
    });
  }

  async function expectSponsored(input: SponsoredInput) {
    const response = await request(input);
    expect(response.statusCode, response.body).toBe(200);
    const sponsorship = Uint8Array.from(Buffer.from(response.json().sponsorship, "hex"));
    expect(verifySponsorship(sponsorship, input, { sponsors: [sponsor.account] })).toMatchObject({
      ok: true,
      value: { sponsor: sponsor.account, notionalCost: 0n },
    });
  }

  async function expectRefused(input: SponsoredInput) {
    const response = await request(input);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe("ERR-SponsorshipRefused");
  }

  it("REQ-SP-3: createEvent is sponsored for the account the event id derives from, and no other", async () => {
    const salt = new Uint8Array(16).fill(0x09);
    const organiser = ledger.organiser.signer;
    const command: Command = {
      kind: "createEvent",
      ...envelope(),
      event: eventId(organiser.account, salt),
      salt,
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
      metadata: null,
    };
    await expectSponsored(await sign(organiser, command));
    await expectRefused(await sign(stranger, command));
  });

  it("REQ-OA-1: createEvent by a registered account that is not a Kippu organiser is refused, even with a derived id", async () => {
    const salt = new Uint8Array(16).fill(0x0a);
    const command: Command = {
      kind: "createEvent",
      ...envelope(),
      event: eventId(outsider.signer.account, salt),
      salt,
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
      metadata: null,
    };
    const response = await request(await sign(outsider.signer, command));
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: "ERR-SponsorshipRefused",
      detail: "the signer is not a Kippu organiser account",
    });
  });

  it("REQ-SP-3: a forged authorisation is refused before any entitlement, whatever account it names", async () => {
    const organiser = ledger.organiser;
    const setStatus: Command = { kind: "setEventStatus", ...envelope(), event, status: "Sealed" };
    // The organiser's credential and account, with a signature by another key.
    const forged = decodeAuthorisation(await stranger.sign(profile.encodeCommand(setStatus)));
    const genuine = decodeAuthorisation(
      await organiser.signer.sign(profile.encodeCommand(setStatus)),
    );
    if (forged.kind !== "p256" || genuine.kind !== "p256") throw new Error("expected p256");
    const claimingOrganiser = encodeAuthorisation({ ...genuine, signature: forged.signature });
    const response = await request({ command: setStatus, authorisation: claimingOrganiser });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: "ERR-SponsorshipRefused",
      detail: "the authorisation does not verify",
    });

    // A genuine authorisation of a different command, replayed on this one.
    const other: Command = { kind: "setEventStatus", ...envelope(), event, status: "Cancelled" };
    const replayed = await organiser.signer.sign(profile.encodeCommand(other));
    await expectRefused({ command: setStatus, authorisation: replayed });

    // A holder's passkey assertion over another payload.
    const transfer: Command = {
      kind: "transferTicket",
      ...envelope(),
      event,
      ticket,
      receiver: bob.account,
    };
    const assertion = await alice.sign(
      profile.encodeCommand({ ...transfer, receiver: alice.account }),
    );
    await expectRefused({ command: transfer, authorisation: assertion });
  });

  it("REQ-SP-3: an authorisation by a credential not registered to its account is refused", async () => {
    const unregistered = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID });
    const pass = await signPass(unregistered.signer, ticket);
    const response = await request(pass);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.detail).toMatch(/not registered/);
  });

  it("REQ-SP-1b: a forged registration is never metered against the account it names", async () => {
    const victim = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID });
    const impostor = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID });
    // The victim's account and registration, authorised by the impostor's credential.
    const forged: Command = {
      kind: "registerCredential",
      ...envelope(),
      account: victim.signer.account,
      registration: victim.registration,
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      await expectRefused(await sign(impostor.signer, forged));
    }
    const genuine: Command = { ...forged, ...envelope() };
    await expectSponsored(await sign(victim.signer, genuine));
    await expectSponsored(await sign(victim.signer, { ...genuine, ...envelope() }));
  });

  it("REQ-SP-3: organiser commands on an event are sponsored for its owner only", async () => {
    const commands = (target: EventId): Command[] =>
      [
        { kind: "setEventStatus", ...envelope(), event: target, status: "Sealed" },
        { kind: "setEventCapacity", ...envelope(), event: target, capacity: 100, proof: null },
        {
          kind: "addZone",
          ...envelope(),
          event: target,
          zone: { id: zoneId(0x61), kind: "Seated" },
        },
        { kind: "removeZone", ...envelope(), event: target, zone },
        {
          kind: "removeRestriction",
          ...envelope(),
          event: target,
          ticket: frozen,
          restriction: "cannotTransfer",
        },
      ] as Command[];
    for (const command of commands(event)) {
      await expectSponsored(await sign(ledger.organiser.signer, command));
      await expectRefused(await sign(stranger, command));
    }
    const unknown = hex(32, 0xee) as EventId;
    for (const command of commands(unknown)) {
      await expectRefused(await sign(ledger.organiser.signer, command));
    }
  });

  it("REQ-SP-2, REQ-SP-3: issueTicket is sponsored when signed by the event's owner, never otherwise", async () => {
    const placement = { kind: "Unseated", discriminator: hex(16, 0x10) as Discriminator } as const;
    const issue: Command = {
      kind: "issueTicket",
      ...envelope(),
      event,
      ticket: profile.ticketId(event, zone, placement),
      zone,
      placement,
      class: classId(0xc1),
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: false, cannotTransfer: false },
      holder: bob.account,
      metadata: null,
    };
    await expectSponsored(await sign(ledger.organiser.signer, issue));
    await expectRefused(await sign(stranger, issue));
    await expectRefused(await sign(alice, issue));
  });

  it("REQ-SP-3: transferTicket is sponsored for the ticket's holder, unless the ticket cannot be transferred", async () => {
    const transfer = (target: TicketId, from: EventId = event): Command => ({
      kind: "transferTicket",
      ...envelope(),
      event: from,
      ticket: target,
      receiver: bob.account,
    });
    await expectSponsored(await sign(alice, transfer(ticket)));
    await expectRefused(await sign(bob, transfer(ticket)));
    await expectRefused(await sign(alice, transfer(frozen)));
    await expectRefused(await sign(alice, transfer(ticket, cancelled)));
    await expectRefused(await sign(alice, transfer(hex(32, 0xef) as TicketId)));
  });

  it("REQ-SP-1: registerCredential is always sponsored, within the rate limit per account", async () => {
    const holder = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID });
    const another = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID });
    const register = (credential: typeof holder): Command => ({
      kind: "registerCredential",
      ...envelope(),
      account: credential.signer.account,
      registration: credential.registration,
    });
    await expectSponsored(await sign(holder.signer, register(holder)));
    await expectSponsored(await sign(holder.signer, register(holder)));
    await expectRefused(await sign(holder.signer, register(holder)));
    await expectSponsored(await sign(another.signer, register(another)));
    clock += 60_001;
    await expectSponsored(await sign(holder.signer, register(holder)));
  });

  it("REQ-SP-3: an access pass is sponsored while its ticket exists and its event is neither Cancelled nor Finished", async () => {
    await expectSponsored(await signPass(alice, ticket));
    await expectRefused(await signPass(alice, cancelledTicket));
    await expectRefused(await signPass(alice, finishedTicket));
    await expectRefused(await signPass(alice, hex(32, 0xed) as TicketId));
  });

  it("refuses a malformed request, and an undecodable input, without sponsoring", async () => {
    for (const payload of [
      {},
      { input: { kind: "command", bytes: "ZZ" } },
      { input: { kind: "other", bytes: "00" } },
      { input: { kind: "command", bytes: "0001" } },
    ]) {
      const response = await relay.inject({ method: "POST", url: "/v0/sponsor", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("malformed");
    }
  });
});
