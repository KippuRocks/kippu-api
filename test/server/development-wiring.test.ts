import { signProofOfControl } from "@ticketto/profile-v0";
import { simulatedWebAuthnSigner } from "@ticketto/profile-v0/testing";
import type { AccountId, EventId, TicketId } from "@ticketto/sdk";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRPC_PREFIX } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { positionOf } from "../../src/events/zones.js";
import type { KippuTicketto } from "../../src/ledger/ticketto.js";
import type { AppRouter } from "../../src/trpc/router.js";
import { createDomainServices, createServer, WiringError } from "../../src/wiring.js";
import { SoftwareAuthenticator } from "../support/authenticator.js";
import {
  createMigratedTestDatabase,
  describeWithStore,
  type TestDatabase,
} from "../support/database.js";
import { randomId } from "../support/events.js";

/** Placeholder hostnames: the real ones are not chosen yet. */
const LOGIN_RP_ID = "login.kippu.example";
const HOLDER_RP_ID = "holder.kippu.example";
const IBENTO = "https://ibento.login.kippu.example";

/** The environment a developer runs the server with, as the README gives it. */
const environment = (databaseUrl: string, ledgerEnvironment: string) => ({
  KIPPU_DATABASE_URL: databaseUrl,
  KIPPU_LOGIN_RP_ID: LOGIN_RP_ID,
  KIPPU_LOGIN_ORIGINS: IBENTO,
  KIPPU_HOLDER_RP_ID: HOLDER_RP_ID,
  KIPPU_LEDGER_ENVIRONMENT: ledgerEnvironment,
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));

describe("the development wiring", () => {
  it("is refused in production", () => {
    const config = loadConfig(
      environment("postgres://kippu_api:x@127.0.0.1:1/kippu_api", "production"),
    );
    expect(() => createDomainServices(config, {} as never)).toThrow(WiringError);
    expect(() => createDomainServices(config, {} as never)).toThrow(/binding-offchain/);
  });
});

describeWithStore("the server, wired for development", () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let ledger: KippuTicketto;
  let address: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const config = loadConfig(environment(database.url, "development"));
    ({ app, ledger } = createServer(config, database.store));
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  function client(token?: string) {
    return createTRPCClient<AppRouter>({
      links: [
        httpLink({
          url: `${address}${TRPC_PREFIX}`,
          headers: () => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
        }),
      ],
    });
  }

  it("an organiser signs in, creates an event and issues a granted ticket through tRPC", async () => {
    const anonymous = client();
    const email = "box-office@organiser.example";
    const passkey = new SoftwareAuthenticator({ origin: IBENTO });

    // Sign up, then sign in again with the same passkey, as Ibento does.
    const signUp = await anonymous.auth.organiser.beginSignUp.mutate({ email });
    await anonymous.auth.organiser.completeSignUp.mutate({
      ceremonyId: signUp.ceremonyId,
      credential: passkey.create(signUp.options),
    });
    const signIn = await anonymous.auth.organiser.beginSignIn.mutate({ email });
    const { session } = await anonymous.auth.organiser.completeSignIn.mutate({
      ceremonyId: signIn.ceremonyId,
      credential: passkey.get(signIn.options),
    });
    const organiser = client(session.token);

    // The event, a seated zone's canonical positions, and a granted class.
    const stalls = randomId();
    const { event } = await organiser.events.create.mutate({
      zones: [{ id: stalls, kind: "Seated" }],
      capacity: 100,
    });
    await organiser.events.zones.addSeatPositions.mutate({
      event,
      zone: stalls,
      positions: ["A-1", "A-2"],
    });
    const press = await organiser.events.classes.define.mutate({
      event,
      name: "Press",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions: { cannotResale: true, cannotTransfer: true },
      quota: 10,
    });

    // A guest with Saifu: their credential is on the ledger, and they link it to Kippu.
    const guest = simulatedWebAuthnSigner({ rpId: HOLDER_RP_ID });
    expect(
      await ledger.registerCredential(guest.signer, {
        account: guest.signer.account,
        registration: guest.registration,
      }),
    ).toMatchObject({ ok: true });
    const link = await anonymous.auth.holder.beginLink.mutate({ account: guest.signer.account });
    const proof = await signProofOfControl(
      {
        audience: bytes(link.challenge.audience),
        nonce: bytes(link.challenge.nonce),
        expiresAt: link.challenge.expiresAt,
        account: link.challenge.account as AccountId,
      },
      guest.signer,
    );
    const linked = await anonymous.auth.holder.completeLink.mutate({
      challengeId: link.challengeId,
      authorisation: hex(proof),
    });
    expect(linked.holder.account).toBe(guest.signer.account);

    const { ticket } = await organiser.events.tickets.issueGranted.mutate({
      event,
      class: press.id,
      zone: stalls,
      placement: { kind: "Seated", position: "A-1" },
      holder: guest.signer.account,
    });

    // The ledger holds the guest's ticket, on the organiser's event.
    expect(await ledger.getTicket(ticket as TicketId)).toMatchObject({
      ok: true,
      value: {
        event,
        holder: guest.signer.account,
        class: press.id,
        provenance: "Granted",
        placement: { kind: "Seated", position: positionOf("A-1") },
        restrictions: { cannotResale: true, cannotTransfer: true },
      },
    });
    expect(await ledger.getEvent(event as EventId)).toMatchObject({
      ok: true,
      value: { status: "Active", issued: 1 },
    });

    // Every write Kippu relayed for the organiser is attributed to their session (NFR-7):
    // the account's registration, the event's creation and the issuance.
    const { principal } = await organiser.auth.session.current.query();
    const relayed = await database.store.query<{
      command_kind: string;
      session_id: string;
      outcome: string;
    }>("SELECT command_kind, session_id, outcome FROM audit_log ORDER BY id");
    expect(relayed.rows).toEqual(
      ["registerCredential", "createEvent", "issueTicket"].map((command_kind) => ({
        command_kind,
        session_id: principal.sessionId,
        outcome: "settled",
      })),
    );
  });
});
