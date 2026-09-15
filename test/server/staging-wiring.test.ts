import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { kmsP256Signer } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import { createProfileV0 } from "@ticketto/profile-v0";
import { type EventId, LOG_START, type LogRecord } from "@ticketto/sdk";
import { createTRPCClient, httpLink } from "@trpc/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRPC_PREFIX } from "../../src/app.js";
import { ConfigError, loadConfig } from "../../src/config.js";
import { makeTicketto } from "../../src/ledger/ticketto.js";
import { loadPaymentsConfig } from "../../src/sales/payments/config.js";
import { paymentProviderFor } from "../../src/sales/payments/provider.js";
import { connectRelayDerivedCopy, type RelayDerivedCopy } from "../../src/sponsor/derived.js";
import { createEntitlements } from "../../src/sponsor/entitlements.js";
import { buildSponsorRelay } from "../../src/sponsor/relay.js";
import type { AppRouter } from "../../src/trpc/router.js";
import {
  connectLedgerBackend,
  createDomainServices,
  createServer,
  type KippuServer,
  WiringError,
} from "../../src/wiring.js";
import { SoftwareAuthenticator } from "../support/authenticator.js";
import { createMigratedTestDatabase, type TestDatabase } from "../support/database.js";
import { randomId } from "../support/events.js";
import { relayLoginRole } from "../support/sponsor-relay.js";

/** Placeholder hostnames: the real ones are not chosen yet. */
const IBENTO = "https://ibento.login.kippu.example";
const HOLDER_RP_ID = "holder.kippu.example";

const environment = (overrides: Record<string, string | undefined> = {}) => ({
  KIPPU_DATABASE_URL: "postgres://kippu_api:x@127.0.0.1:1/kippu_api",
  KIPPU_LOGIN_RP_ID: "login.kippu.example",
  KIPPU_LOGIN_ORIGINS: IBENTO,
  KIPPU_HOLDER_RP_ID: HOLDER_RP_ID,
  KIPPU_LEDGER_ENVIRONMENT: "staging",
  KIPPU_LEDGER_SERVICE_URL: "http://127.0.0.1:8080",
  KIPPU_SPONSOR_URL: "http://127.0.0.1:8082",
  ...overrides,
});

describe("the staging wiring (T-023-08)", () => {
  it("reads the ledger service's endpoint and the sponsor relay, and needs both", () => {
    expect(loadConfig(environment())).toMatchObject({
      ledgerEnvironment: "staging",
      ledgerServiceUrl: "http://127.0.0.1:8080",
      sponsorRelayUrl: "http://127.0.0.1:8082",
    });
    expect(() => loadConfig(environment({ KIPPU_LEDGER_SERVICE_URL: undefined }))).toThrow(
      /KIPPU_LEDGER_SERVICE_URL/,
    );
    expect(() => loadConfig(environment({ KIPPU_SPONSOR_URL: undefined }))).toThrow(
      /KIPPU_SPONSOR_URL/,
    );
  });

  it("REQ-SDK-9: the ledger service is an http(s) endpoint, never a database, and only in staging", () => {
    expect(() =>
      loadConfig(environment({ KIPPU_LEDGER_SERVICE_URL: "postgres://ticketto@db/ticketto" })),
    ).toThrow(ConfigError);
    expect(() => loadConfig(environment({ TICKETTO_DATABASE_URL: "postgres://t@db/t" }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(environment({ KIPPU_LEDGER_ENVIRONMENT: "development" }))).toThrow(
      /only read in staging/,
    );
  });

  it("refuses staging without a connected ledger backend, and production altogether", () => {
    const store = {} as never;
    expect(() => createDomainServices(loadConfig(environment()), store)).toThrow(WiringError);
    expect(() =>
      makeTicketto({
        environment: "staging",
        holderRpId: HOLDER_RP_ID,
        sponsor: {
          sponsor: async () => ({ ok: false, error: { code: "ERR-SponsorshipRefused" } }),
        },
        operationLifetime: 60_000,
      }),
    ).toThrow(/binding-offchain/);
    const production = loadConfig(
      environment({ KIPPU_LEDGER_ENVIRONMENT: "production", KIPPU_LEDGER_SERVICE_URL: undefined }),
    );
    expect(() => createDomainServices(production, store)).toThrow(WiringError);
  });

  it("REQ-SDK-9: no ledger-service database credential exists anywhere in kippu-api's code or deployment files", async () => {
    const root = new URL("../../", import.meta.url);
    const files: URL[] = [];
    for (const directory of ["src", "migrations", ".github"]) {
      const entries = await readdir(new URL(`${directory}/`, root), {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile()) files.push(new URL(`file://${entry.parentPath}/${entry.name}`));
      }
    }
    files.push(new URL("compose.yaml", root), new URL("Dockerfile", root));
    const credential =
      /\b(TICKETTO|LEDGER)[A-Z0-9_]*_(DATABASE|DB|PG|POSTGRES)[A-Z0-9_]*\b|postgres(ql)?:\/\/[^\s"'`]*ticketto/i;
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text.match(credential), file.pathname).toBeNull();
    }
  });
});

/**
 * Against a `ticketto-offchain` running locally (`TICKETTO_ENVIRONMENT=staging`,
 * with `KIPPU_TEST_SPONSOR_SECRET_KEY`'s account among `TICKETTO_SPONSOR_ACCOUNTS`).
 * The service is private and not published, so this runs where one is started —
 * locally, and in `kippu-e2e` (`F-070`) — and is skipped elsewhere.
 */
const ledgerServiceUrl = process.env.KIPPU_TEST_LEDGER_SERVICE_URL;
const sponsorSecret = process.env.KIPPU_TEST_SPONSOR_SECRET_KEY;
const databaseServer = process.env.KIPPU_TEST_DATABASE_URL;

describe.runIf(Boolean(ledgerServiceUrl && sponsorSecret && databaseServer))(
  "the server in staging, against a local ticketto-offchain",
  () => {
    let database: TestDatabase;
    let role: Awaited<ReturnType<typeof relayLoginRole>>;
    let derived: RelayDerivedCopy;
    let relay: FastifyInstance;
    let server: KippuServer;
    let address: string;

    beforeAll(async () => {
      database = await createMigratedTestDatabase();
      role = await relayLoginRole(database.url);
      derived = connectRelayDerivedCopy(role.url);
      relay = buildSponsorRelay({
        sponsor: kmsP256Signer(
          softwareKmsP256Key({
            secretKey: Uint8Array.from(Buffer.from(sponsorSecret ?? "", "hex")),
          }),
        ),
        derived,
        entitlements: createEntitlements({
          derived: derived.queries,
          organisers: derived.organisers,
          profile: createProfileV0({ rpId: "holder.kippu.example" }),
          registrationRateLimit: { registrations: 5, window: 60_000 },
        }),
        lagWait: 20_000,
      });
      await relay.listen({ host: "127.0.0.1", port: 0 });
      const config = loadConfig(
        environment({
          KIPPU_DATABASE_URL: database.url,
          KIPPU_LEDGER_SERVICE_URL: ledgerServiceUrl,
          KIPPU_SPONSOR_URL: `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`,
        }),
      );
      const ledgerBackend = await connectLedgerBackend(config);
      server = createServer(
        config,
        database.store,
        {},
        {
          ...(ledgerBackend === undefined ? {} : { ledgerBackend }),
          // As a kippu-e2e stack runs staging: the test payment provider, named explicitly.
          payments: (() => {
            const payments = loadPaymentsConfig("staging", { KIPPU_PAYMENTS_PROVIDER: "test" });
            return { provider: paymentProviderFor(payments), publicUrl: payments.publicUrl };
          })(),
        },
      );
      server.start();
      address = await server.app.listen({ host: "127.0.0.1", port: 0 });
    }, 60_000);

    afterAll(async () => {
      await server?.close();
      await relay?.close();
      await derived?.close();
      await role?.drop();
      await database?.drop();
    });

    it("an event created through tRPC is in the ledger service's log", {
      timeout: 120_000,
    }, async () => {
      const client = (token?: string) =>
        createTRPCClient<AppRouter>({
          links: [
            httpLink({
              url: `${address}${TRPC_PREFIX}`,
              headers: () => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
            }),
          ],
        });
      const anonymous = client();
      const email = `staging-${randomId().slice(0, 8)}@organiser.example`;
      const passkey = new SoftwareAuthenticator({ origin: IBENTO });
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

      const { event } = await client(session.token).events.create.mutate({
        zones: [{ id: randomId(), kind: "Unseated" }],
        capacity: 10,
      });

      // Read back from the service itself, through binding-offchain's log reader.
      const records: LogRecord[] = [];
      let cursor = LOG_START;
      for (;;) {
        const page = await server.ledger.log.read(cursor, 100);
        if (!page.ok) expect.fail(page.error.code);
        if (page.value.records.length === 0) break;
        records.push(...page.value.records);
        cursor = page.value.next;
      }
      const created = records.find(
        (record) =>
          "command" in record.entry &&
          record.entry.command.kind === "createEvent" &&
          record.entry.command.event === event,
      );
      expect(created).toBeDefined();
      expect(await server.ledger.getEvent(event as EventId)).toMatchObject({
        ok: true,
        value: { id: event, status: "Active" },
      });
    });
  },
);
