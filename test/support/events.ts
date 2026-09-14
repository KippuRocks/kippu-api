import { randomBytes } from "node:crypto";
import type { EventId, OperationId, Sponsor, Sponsorship, ZoneId } from "@ticketto/sdk";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { buildApp, TRPC_PREFIX } from "../../src/app.js";
import { type AuditLog, createAuditLog, type RelayRequest } from "../../src/audit/audit-log.js";
import type { Auth, SessionInfo } from "../../src/auth/ports.js";
import {
  createOrganiserAuthority,
  type OrganiserAuthority,
} from "../../src/authority/authority.js";
import { softwareOrganiserKms } from "../../src/authority/kms.js";
import { createEvents } from "../../src/events/service.js";
import { type KippuTicketto, makeTicketto } from "../../src/ledger/ticketto.js";
import type { AppRouter } from "../../src/trpc/router.js";
import { createMigratedTestDatabase, type TestDatabase } from "./database.js";
import { createOrganiser } from "./organisers.js";

/** Placeholder: the real holder RP id is not chosen yet. */
export const HOLDER_RP_ID = "holder.kippu.example";

/** A random 32-byte identifier, such as a zone id. */
export const randomId = () => randomBytes(32).toString("hex") as ZoneId;

export interface TestOrganiser {
  readonly organiserId: string;
  readonly request: RelayRequest;
  /** A tRPC client signed in as this organiser. */
  readonly client: ReturnType<typeof createTRPCClient<AppRouter>>;
}

/**
 * kippu-api's events services over a migrated test store and `backend-memory`,
 * served over HTTP. Organiser sessions are stubbed: sign-in belongs to
 * `T-020-05`, and a bearer token here names an organiser directly.
 */
export interface EventsHarness {
  readonly database: TestDatabase;
  readonly audit: AuditLog;
  readonly ledger: KippuTicketto;
  readonly authority: OrganiserAuthority;
  /** The operation id of every command the sponsor was asked to sponsor, in order (`REQ-SP-1`). */
  readonly sponsored: readonly OperationId[];
  organiser(): Promise<TestOrganiser>;
  /** An event created with the organiser's authority, straight through the SDK. */
  createEventDirectly(
    organiser: TestOrganiser,
    zones?: readonly { id: ZoneId; kind: "Seated" | "Unseated" }[],
    capacity?: number | null,
  ): Promise<EventId>;
  close(): Promise<void>;
}

export async function eventsHarness(): Promise<EventsHarness> {
  const database = await createMigratedTestDatabase();
  const audit = createAuditLog(database.store);
  const sponsored: OperationId[] = [];
  const sponsor: Sponsor = {
    sponsor: async (input) => {
      if ("command" in input) sponsored.push(input.command.operationId);
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
    audit,
    ledger,
    onAuditFailure: (error) => {
      throw error;
    },
  });
  const events = createEvents({ store: database.store, authority, ledger });

  const sessions = new Map<string, SessionInfo>();
  const auth = new Proxy({} as Auth, {
    get: (_, name) =>
      name === "authenticate"
        ? async (token: string) => sessions.get(token) ?? null
        : () => {
            throw new Error("sign-in is not part of these tests");
          },
  });

  const app: FastifyInstance = buildApp({}, undefined, { auth, events });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  return {
    database,
    audit,
    ledger,
    authority,
    sponsored,

    async organiser() {
      const { organiserId, request } = await createOrganiser(database.store);
      const token = randomBytes(24).toString("base64url");
      if (request.principal.kind !== "organiser") throw new Error("expected an organiser");
      sessions.set(token, {
        principal: request.principal,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const client = createTRPCClient<AppRouter>({
        links: [
          httpLink({
            url: `${address}${TRPC_PREFIX}`,
            headers: () => ({ authorization: `Bearer ${token}` }),
          }),
        ],
      });
      return { organiserId, request, client };
    },

    async createEventDirectly(
      organiser,
      zones = [{ id: randomId(), kind: "Unseated" }],
      capacity = null,
    ) {
      const created = await authority.relay(organiser.organiserId, organiser.request, (signer) =>
        ledger.createEvent(signer, {
          salt: randomBytes(32),
          zones,
          capacity,
          metadata: null,
        }),
      );
      expect(await created.submission).toMatchObject({ ok: true });
      return created.id;
    },

    async close() {
      await app.close();
      await database.drop();
    },
  };
}

/** How a tRPC call was refused: its transport code and §10 code, if it had one. */
export async function refusal(
  call: () => Promise<unknown>,
): Promise<{ code: string | undefined; errorCode: string | null | undefined }> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TRPCClientError) {
      const typed = error as TRPCClientError<AppRouter>;
      return { code: typed.data?.code, errorCode: typed.data?.errorCode };
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}
