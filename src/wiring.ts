import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { buildApp } from "./app.js";
import { createAuditLog } from "./audit/audit-log.js";
import type { Services } from "./auth/ports.js";
import { createAuth } from "./auth/service.js";
import { createOrganiserAuthority } from "./authority/authority.js";
import { organiserKmsFor } from "./authority/kms.js";
import type { Config } from "./config.js";
import { createEvents } from "./events/service.js";
import { developmentSponsor } from "./ledger/development-sponsor.js";
import { type KippuTicketto, makeTicketto } from "./ledger/ticketto.js";
import type { MetadataConfig } from "./metadata/config.js";
import { createMetadataDocuments } from "./metadata/documents.js";
import { createS3MetadataStorage } from "./metadata/storage.js";
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
  /**
   * Metadata object storage, for organisers' document editing (`F-026`). Without
   * it, the metadata editing procedures fail and everything else is served.
   */
  readonly metadata?: MetadataConfig;
}

export interface DomainServices {
  /** Metadata editing is absent without object storage; `buildApp` fills it with a failing service. */
  readonly services: Pick<Services, "auth" | "events"> & Partial<Pick<Services, "metadata">>;
  readonly ledger: KippuTicketto;
}

/**
 * The domain services the server mounts, over the ledger its environment names
 * (`T-021-11`): identity and holder linking (`F-020`), events, zones, classes
 * and granted issuance (`F-021`), and — given object storage — metadata document
 * editing (`F-026`).
 *
 * In `development` and `test` they run over `backend-memory`, a software KMS for
 * organiser keys, and a development sponsor — all in this process's memory, so
 * the ledger, and every organiser key, is gone when it exits. `production` is
 * refused: it needs `binding-offchain`, a KMS provider and the sponsor relay's
 * client (`T-023-07`), and none exists yet.
 */
export function createDomainServices(
  config: Pick<Config, "ledgerEnvironment" | "login" | "holderRpId">,
  store: Store,
  options: WiringOptions = {},
): DomainServices {
  const environment = config.ledgerEnvironment;
  if (environment === "production") {
    throw new WiringError(
      "KIPPU_LEDGER_ENVIRONMENT=production is refused: the production ledger backend " +
        "(binding-offchain), a KMS provider for organiser keys and the sponsor relay's client " +
        "do not exist yet. Use development locally.",
    );
  }
  const ledger = makeTicketto({
    environment,
    holderRpId: config.holderRpId,
    sponsor: developmentSponsor(),
    operationLifetime: DEVELOPMENT_OPERATION_LIFETIME,
  });
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
  const publicUrl = options.metadata?.publicUrl;
  const events = createEvents({
    store,
    authority,
    ledger,
    ...(publicUrl === undefined ? {} : { metadataPublicUrl: publicUrl }),
  });
  const metadata =
    options.metadata === undefined
      ? undefined
      : createMetadataDocuments({
          store,
          storage: createS3MetadataStorage(options.metadata.storage),
          ledger,
          authority,
          publicUrl: options.metadata.publicUrl,
        });
  return {
    services: metadata === undefined ? { auth, events } : { auth, events, metadata },
    ledger,
  };
}

/** The API server's application, with its domain services mounted. */
export function createServer(
  config: Pick<Config, "ledgerEnvironment" | "login" | "holderRpId">,
  store: Store,
  options: FastifyServerOptions = {},
  wiring: WiringOptions = {},
): { readonly app: FastifyInstance; readonly ledger: KippuTicketto } {
  const { services, ledger } = createDomainServices(config, store, wiring);
  return { app: buildApp(options, undefined, services), ledger };
}
