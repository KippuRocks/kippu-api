import { randomBytes, randomUUID } from "node:crypto";
import type { EventId, Sponsor, Sponsorship, ZoneId } from "@ticketto/sdk";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import { createAuditLog } from "../../src/audit/audit-log.js";
import type { Auth } from "../../src/auth/ports.js";
import { createAuth } from "../../src/auth/service.js";
import {
  createOrganiserAuthority,
  type OrganiserAuthority,
} from "../../src/authority/authority.js";
import { softwareOrganiserKms } from "../../src/authority/kms.js";
import { type KippuTicketto, makeTicketto } from "../../src/ledger/ticketto.js";
import { createOperators } from "../../src/operators/service.js";
import type { AppRouter } from "../../src/trpc/router.js";
import { SoftwareAuthenticator } from "./authenticator.js";
import { createMigratedTestDatabase, type TestDatabase } from "./database.js";

/** Placeholder hostnames: the real ones are not chosen yet. */
const LOGIN_RP_ID = "login.kippu.example";
const IBENTO = "https://ibento.login.kippu.example";
const HOLDER_RP_ID = "holder.kippu.example";

export type Client = ReturnType<typeof createTRPCClient<AppRouter>>;

export interface SignedInOrganiser {
  readonly organiserId: string;
  readonly client: Client;
}

/**
 * kippu-api's real authentication and operator services over a migrated test
 * store and `backend-memory`, served over HTTP, with a clock the test moves.
 * Organisers sign up with a software passkey; operators redeem the codes their
 * organiser issues.
 */
export interface OperatorHarness {
  readonly database: TestDatabase;
  readonly auth: Auth;
  readonly ledger: KippuTicketto;
  readonly authority: OrganiserAuthority;
  /** How many commands the sponsor was asked to sponsor: every ledger write Kippu made. */
  sponsoredWrites(): number;
  /** An event created with the organiser's authority, straight through the SDK. */
  createEvent(organiserId: string): Promise<EventId>;
  now(): Date;
  advance(ms: number): void;
  /** A client sending `token` as its bearer token, or no session without one. */
  client(token?: string): Client;
  /** An organiser who signed up through `auth.organiser`, in their session. */
  organiser(): Promise<SignedInOrganiser>;
  close(): Promise<void>;
}

export async function operatorHarness(
  start = new Date("2026-09-14T09:00:00Z"),
): Promise<OperatorHarness> {
  const database = await createMigratedTestDatabase();
  let clock = start;
  const now = () => clock;
  const auth = createAuth({
    store: database.store,
    relyingParty: { id: LOGIN_RP_ID, origins: [IBENTO] },
    now,
  });
  let sponsored = 0;
  const sponsor: Sponsor = {
    sponsor: async () => {
      sponsored += 1;
      return { ok: true, value: new Uint8Array() as Sponsorship };
    },
  };
  const ledger = makeTicketto({
    environment: "test",
    holderRpId: HOLDER_RP_ID,
    sponsor,
    operationLifetime: 60_000,
  });
  const authority = createOrganiserAuthority({
    store: database.store,
    kms: softwareOrganiserKms(),
    audit: createAuditLog(database.store),
    ledger,
    onAuditFailure: (error) => {
      throw error;
    },
  });
  const operators = createOperators({ store: database.store, ledger, authority, now });
  const app: FastifyInstance = buildApp({}, undefined, { auth, operators });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const client = (token?: string): Client =>
    createTRPCClient<AppRouter>({
      links: [
        httpLink({
          url: `${address}${TRPC_PREFIX}`,
          headers: () => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
        }),
      ],
    });

  let organisers = 0;
  return {
    database,
    auth,
    ledger,
    authority,
    sponsoredWrites: () => sponsored,
    async createEvent(organiserId) {
      const request = {
        requestId: `req-${randomUUID()}`,
        principal: { kind: "organiser", organiserId, sessionId: randomUUID() },
      } as const;
      const created = await authority.relay(organiserId, request, (signer) =>
        ledger.createEvent(signer, {
          salt: randomBytes(32),
          zones: [{ id: randomBytes(32).toString("hex") as ZoneId, kind: "Unseated" }],
          capacity: null,
          metadata: null,
        }),
      );
      const settled = await created.submission;
      if (!settled.ok) throw new Error(settled.error.code);
      return created.id;
    },
    now,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    client,
    async organiser() {
      const authenticator = new SoftwareAuthenticator({ origin: IBENTO });
      const anonymous = client();
      const challenge = await anonymous.auth.organiser.beginSignUp.mutate({
        email: `organiser${++organisers}-${Date.now()}@kippu.example`,
      });
      const { session, organiser } = await anonymous.auth.organiser.completeSignUp.mutate({
        ceremonyId: challenge.ceremonyId,
        credential: authenticator.create(challenge.options),
      });
      return { organiserId: organiser.id, client: client(session.token) };
    },
    async close() {
      await app.close();
      await database.drop();
    },
  };
}

/** How a tRPC call was refused: its transport code and platform reason. */
export async function refused(
  call: () => Promise<unknown>,
): Promise<{ code: string | undefined; reason: string | null | undefined }> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const typed = error as TRPCClientError<AppRouter>;
      return { code: typed.data?.code, reason: typed.data?.reason };
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}
