import { randomUUID } from "node:crypto";
import { createRelaySponsor } from "@kippu/sponsorship";
import { connectOffchainBackend } from "@ticketto/binding-offchain";
import type { Backend } from "@ticketto/sdk";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { buildApp } from "./app.js";
import { createAuditLog } from "./audit/audit-log.js";
import type { Services } from "./auth/ports.js";
import { createAuth } from "./auth/service.js";
import { createOrganiserAuthority } from "./authority/authority.js";
import { organiserKmsFor } from "./authority/kms.js";
import type { Config } from "./config.js";
import { createFreshness, type Freshness } from "./derived/freshness.js";
import { ledgerFactsProjection } from "./derived/ledger-facts.js";
import { createDerivedReader, type DerivedReader } from "./derived/reader.js";
import { createReads } from "./derived/reads.js";
import { createEvents } from "./events/service.js";
import { developmentSponsor } from "./ledger/development-sponsor.js";
import { type ReceiptTracker, trackReceipts } from "./ledger/receipts.js";
import { ledgerLimits } from "./ledger/rules.js";
import { type KippuTicketto, makeTicketto } from "./ledger/ticketto.js";
import { createMetadataDocuments } from "./metadata/documents.js";
import type { MetadataStorage } from "./metadata/storage.js";
import { type AdmissionReports, createAdmissionReports } from "./operators/reports.js";
import { createOperators } from "./operators/service.js";
import { type LapseSweeper, lapseSweeper } from "./sales/holds.js";
import { PAYMENT_WEBHOOK_PATH } from "./sales/payment.js";
import type { PaymentProvider } from "./sales/payments/ports.js";
import {
  createTestPaymentProvider,
  isTestPaymentProvider,
  type TestPaymentProvider,
} from "./sales/payments/test-provider.js";
import { registerPaymentTestingRoute } from "./sales/payments/testing-route.js";
import { createSales } from "./sales/service.js";
import type { Store } from "./store/store.js";

/**
 * How long a command the domain services assemble stays valid. `AD-15` sets no
 * default; five minutes covers a slow development backend (`NFR-9`), well inside
 * the ledger's 24-hour maximum.
 */
export const DEVELOPMENT_OPERATION_LIFETIME = 5 * 60 * 1000;

/** kippu-api's public origin in development, when none is configured. */
export const DEVELOPMENT_PUBLIC_URL = "http://localhost:8080";

/**
 * `binding-offchain`, connected to the ledger service `config.ledgerServiceUrl`
 * names (`T-023-08`): its assurance declaration is read on connecting. `undefined`
 * outside `staging`, where the ledger is `backend-memory`. The only configuration
 * is the service's endpoint: kippu-api holds no credential for its store
 * (`REQ-SDK-9`).
 */
export async function connectLedgerBackend(
  config: Pick<Config, "ledgerEnvironment" | "ledgerServiceUrl">,
): Promise<Backend | undefined> {
  if (config.ledgerEnvironment !== "staging") return undefined;
  if (config.ledgerServiceUrl === undefined) {
    throw new WiringError("staging needs KIPPU_LEDGER_SERVICE_URL");
  }
  const connected = await connectOffchainBackend({ url: config.ledgerServiceUrl });
  if (!connected.ok) {
    throw new WiringError(
      `the ledger service at ${config.ledgerServiceUrl} cannot be reached: ${connected.error.code}`,
    );
  }
  return connected.value;
}

export class WiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WiringError";
  }
}

export interface WiringOptions {
  /** The public origin metadata locators name (`AD-22`); defaults to `https://meta.kippu.rocks`. */
  readonly metadataPublicUrl?: string;
  /**
   * Kippu's metadata object storage (`F-026`). Without it, organisers' document
   * editing fails, and reads join no documents (`REQ-MD-2`); everything else is served.
   */
  readonly metadataStorage?: MetadataStorage;
  /**
   * The ledger backend in `staging`: `binding-offchain`, connected to the ledger
   * service with {@link connectLedgerBackend}. Ignored in `development` and `test`.
   */
  readonly ledgerBackend?: Backend;
  /** Receives every failure of the derived copy's background reader. Defaults to `console.error`. */
  readonly onReaderError?: (error: unknown) => void;
  /** Receives every failure of the background task recording lapsed holds. Defaults to `console.error`. */
  readonly onLapseSweepError?: (error: unknown) => void;
  /**
   * The payment provider, and kippu-api's public origin its webhooks are sent to
   * (`T-022-04`; `paymentsFor`). Defaults, in `development` and `test` only, to
   * the deterministic test provider and `http://localhost:8080`.
   */
  readonly payments?: { readonly provider: PaymentProvider; readonly publicUrl: string };
}

export interface DomainServices {
  /** Metadata editing is absent without object storage; `buildApp` fills it with a failing service. */
  readonly services: Pick<Services, "auth" | "events" | "derived" | "sales" | "operators"> &
    Partial<Pick<Services, "metadata">>;
  readonly ledger: KippuTicketto;
  /** The derived copy's reader over the ledger's log (`NFR-11`); not started. */
  readonly reader: DerivedReader;
  readonly freshness: Freshness;
  /** Records lapsed holds in the background (`T-022-03`); not started. */
  readonly lapses: LapseSweeper;
  /** Iriguchi's admission reports (`T-024-04`), for `F-025`'s provisional-admission flags. */
  readonly admissionReports: AdmissionReports;
  /**
   * The test payment provider end-to-end suites may drive over HTTP, in
   * `development` and `test` when it is the provider in use; `null` otherwise.
   */
  readonly testingPayments: TestPaymentProvider | null;
}

/** Storage holding nothing: reads find no document, and writes are refused. */
const NO_METADATA_STORAGE: Pick<MetadataStorage, "get"> = { get: async () => null };

/**
 * The domain services the server mounts, over the ledger its environment names
 * (`T-021-11`): identity and holder linking (`F-020`); events, zones, classes
 * and granted issuance (`F-021`); checkout (`F-022`); operator accounts, grants, the check and admission reports (`F-024`);
 * the derived copy's reader
 * and read routes (`F-025`); and, given object storage, metadata document editing (`F-026`).
 *
 * In `development` and `test` they run over `backend-memory`, a software KMS for
 * organiser keys, and a development sponsor — unless `KIPPU_SPONSOR_URL` names
 * the sponsor relay, whose client then sponsors every write — all in this process's memory, so
 * the ledger, and every organiser key, is gone when it exits. In `staging` the
 * SDK runs over `binding-offchain` against a `ticketto-offchain`, sponsored
 * through the relay (`T-023-08`); organiser keys are still in a software KMS.
 * `production` is refused until a KMS provider is chosen.
 */
export function createDomainServices(
  config: Pick<
    Config,
    "ledgerEnvironment" | "login" | "holderRpId" | "sponsorRelayUrl" | "ledgerServiceUrl"
  >,
  store: Store,
  options: WiringOptions = {},
): DomainServices {
  const environment = config.ledgerEnvironment;
  if (environment === "production") {
    throw new WiringError(
      "KIPPU_LEDGER_ENVIRONMENT=production is refused: no KMS provider for organiser keys is " +
        "chosen yet. Use staging against a ticketto-offchain, or development locally.",
    );
  }
  if (environment === "staging") {
    if (options.ledgerBackend === undefined || config.sponsorRelayUrl === undefined) {
      throw new WiringError(
        "staging needs binding-offchain connected to the ledger service, and the sponsor relay",
      );
    }
  }
  const publicUrl = options.metadataPublicUrl;
  // Sponsored through the relay when one is configured, with its entitlements and
  // the latest receipt cursor; otherwise by the development sponsor (F-023).
  let receipts: ReceiptTracker | undefined;
  const sponsor =
    config.sponsorRelayUrl === undefined
      ? developmentSponsor()
      : createRelaySponsor({
          url: config.sponsorRelayUrl,
          receiptCursor: () => receipts?.latest(),
        });
  const tracked = trackReceipts(
    makeTicketto({
      environment,
      holderRpId: config.holderRpId,
      sponsor,
      operationLifetime: DEVELOPMENT_OPERATION_LIFETIME,
      ...(environment === "staging" && options.ledgerBackend !== undefined
        ? { backend: options.ledgerBackend }
        : {}),
    }),
  );
  receipts = tracked.receipts;
  const ledger = tracked.ledger;
  const audit = createAuditLog(store);
  const authority = createOrganiserAuthority({
    store,
    kms: organiserKmsFor(environment),
    audit,
    ledger,
  });
  const auth = createAuth({
    store,
    relyingParty: config.login,
    holders: { credentials: ledger, holderRpId: config.holderRpId },
  });
  const events = createEvents({
    store,
    authority,
    ledger,
    maxPassWindow: ledgerLimits().maxPassWindow,
    ...(publicUrl === undefined ? {} : { metadataPublicUrl: publicUrl }),
  });
  const reader = createDerivedReader({
    store,
    log: ledger.log,
    projections: [ledgerFactsProjection(ledger)],
    ...(options.onReaderError === undefined ? {} : { onError: options.onReaderError }),
  });
  const freshness = createFreshness({ store });
  const derived = createReads({
    store,
    freshness,
    storage: options.metadataStorage ?? NO_METADATA_STORAGE,
    authority,
    ...(publicUrl === undefined ? {} : { publicUrl }),
  });
  if (options.payments === undefined && environment === "staging") {
    throw new WiringError("staging needs a payment provider and kippu-api's public URL");
  }
  const payments = options.payments ?? {
    provider: createTestPaymentProvider(),
    publicUrl: DEVELOPMENT_PUBLIC_URL,
  };
  const sales = createSales({
    store,
    ledger,
    authority,
    freshness,
    classes: events.classes,
    zones: events.zones,
    seats: events.seats,
    provider: payments.provider,
    webhookUrl: new URL(PAYMENT_WEBHOOK_PATH, payments.publicUrl).toString(),
    ...(options.onLapseSweepError === undefined ? {} : { onError: options.onLapseSweepError }),
  });
  // Records lapses, and cancels the hosted checkouts of holds that ended (T-022-04).
  const lapses = lapseSweeper(
    { lapseExpired: () => sales.payments.sweep(`sweep-${randomUUID()}`) },
    options.onLapseSweepError,
  );
  const admissionReports = createAdmissionReports({ store });
  const operators = createOperators({ store, ledger, authority, reports: admissionReports });
  const base = { auth, events, derived, sales, operators };
  const services =
    options.metadataStorage === undefined
      ? base
      : {
          ...base,
          metadata: createMetadataDocuments({
            store,
            storage: options.metadataStorage,
            ledger,
            authority,
            ...(publicUrl === undefined ? {} : { publicUrl }),
          }),
        };
  const testingPayments =
    (environment === "development" || environment === "test") &&
    isTestPaymentProvider(payments.provider)
      ? payments.provider
      : null;
  return { services, ledger, reader, freshness, lapses, admissionReports, testingPayments };
}

export interface KippuServer {
  readonly app: FastifyInstance;
  readonly ledger: KippuTicketto;
  /** Starts the derived copy's background reader. */
  start(): void;
  /** Stops the reader, and the application. */
  close(): Promise<void>;
}

/** The API server's application, with its domain services mounted. */
export function createServer(
  config: Pick<
    Config,
    "ledgerEnvironment" | "login" | "holderRpId" | "sponsorRelayUrl" | "ledgerServiceUrl"
  >,
  store: Store,
  options: FastifyServerOptions = {},
  wiring: WiringOptions = {},
): KippuServer {
  const { services, ledger, reader, freshness, lapses, testingPayments } = createDomainServices(
    config,
    store,
    wiring,
  );
  const app = buildApp(options, undefined, services);
  if (testingPayments !== null) {
    registerPaymentTestingRoute(app, testingPayments, services.sales);
  }
  return {
    app,
    ledger,
    start: () => {
      reader.start();
      lapses.start();
    },
    async close() {
      await reader.stop();
      await lapses.stop();
      await freshness.close();
      await app.close();
    },
  };
}
