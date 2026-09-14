import { createRelaySponsor } from "@kippu/sponsorship";
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
import { type KippuTicketto, makeTicketto } from "./ledger/ticketto.js";
import { createMetadataDocuments } from "./metadata/documents.js";
import type { MetadataStorage } from "./metadata/storage.js";
import type { Store } from "./store/store.js";

/**
 * How long a command the domain services assemble stays valid. `AD-15` sets no
 * default; five minutes covers a slow development backend (`NFR-9`), well inside
 * the ledger's 24-hour maximum.
 */
export const DEVELOPMENT_OPERATION_LIFETIME = 5 * 60 * 1000;

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
  /** Receives every failure of the derived copy's background reader. Defaults to `console.error`. */
  readonly onReaderError?: (error: unknown) => void;
}

export interface DomainServices {
  /** Metadata editing is absent without object storage; `buildApp` fills it with a failing service. */
  readonly services: Pick<Services, "auth" | "events" | "derived"> &
    Partial<Pick<Services, "metadata">>;
  readonly ledger: KippuTicketto;
  /** The derived copy's reader over the ledger's log (`NFR-11`); not started. */
  readonly reader: DerivedReader;
  readonly freshness: Freshness;
}

/** Storage holding nothing: reads find no document, and writes are refused. */
const NO_METADATA_STORAGE: Pick<MetadataStorage, "get"> = { get: async () => null };

/**
 * The domain services the server mounts, over the ledger its environment names
 * (`T-021-11`): identity and holder linking (`F-020`); events, zones, classes
 * and granted issuance (`F-021`); the derived copy's reader and read routes
 * (`F-025`); and, given object storage, metadata document editing (`F-026`).
 *
 * In `development` and `test` they run over `backend-memory`, a software KMS for
 * organiser keys, and a development sponsor — unless `KIPPU_SPONSOR_URL` names
 * the sponsor relay, whose client then sponsors every write — all in this process's memory, so
 * the ledger, and every organiser key, is gone when it exits. `production` is
 * refused: it needs `binding-offchain`, a KMS provider and the sponsor relay's
 * client, and the first two do not exist yet.
 */
export function createDomainServices(
  config: Pick<Config, "ledgerEnvironment" | "login" | "holderRpId" | "sponsorRelayUrl">,
  store: Store,
  options: WiringOptions = {},
): DomainServices {
  const environment = config.ledgerEnvironment;
  if (environment === "production") {
    throw new WiringError(
      "KIPPU_LEDGER_ENVIRONMENT=production is refused: the production ledger backend " +
        "(binding-offchain), a KMS provider for organiser keys and the sponsor relay's client " +
        "are not wired yet. Use development locally.",
    );
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
  const base = { auth, events, derived };
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
  return { services, ledger, reader, freshness };
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
  config: Pick<Config, "ledgerEnvironment" | "login" | "holderRpId" | "sponsorRelayUrl">,
  store: Store,
  options: FastifyServerOptions = {},
  wiring: WiringOptions = {},
): KippuServer {
  const { services, ledger, reader, freshness } = createDomainServices(config, store, wiring);
  const app = buildApp(options, undefined, services);
  return {
    app,
    ledger,
    start: () => reader.start(),
    async close() {
      await reader.stop();
      await freshness.close();
      await app.close();
    },
  };
}
