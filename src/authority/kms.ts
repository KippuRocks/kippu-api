import { randomUUID } from "node:crypto";
import type { KmsP256Key } from "@kippu/sponsorship";
import { softwareKmsP256Key } from "@kippu/sponsorship/testing";
import type { LedgerEnvironment } from "../ledger/ticketto.js";

/**
 * Where organisers' `p256` keys are held (`REQ-OA-1`; `F-021` plan §5.1): one
 * key per organiser, in a managed KMS or HSM, never in the application
 * database (`PLAN.md` §3.5).
 *
 * A key is reached through `@kippu/sponsorship`'s `KmsP256Key`, the same narrow
 * surface the sponsor's key uses: the public key, and ECDSA P-256 over a digest.
 * The Kippu store keeps only a key's reference and its public key.
 */
export interface OrganiserKms {
  /** Creates a new `p256` key for an organiser, and returns it with its reference in the KMS. */
  createKey(organiserId: string): Promise<{ readonly keyRef: string; readonly key: KmsP256Key }>;
  /** The key a reference names. Throws when the KMS holds no such key. */
  key(keyRef: string): Promise<KmsP256Key>;
}

/**
 * A software stand-in for the KMS, for development and tests only: its secret
 * keys are plain bytes in this process's memory, and are lost when it exits.
 * So is `backend-memory`'s ledger, which is the only ledger it is used with.
 *
 * No KMS provider is chosen. A managed provider's adapter implements
 * `OrganiserKms` — creating a key per organiser under a per-organiser key
 * policy — and replaces this in production.
 */
export function softwareOrganiserKms(): OrganiserKms {
  const keys = new Map<string, KmsP256Key>();
  return {
    async createKey() {
      const keyRef = `software:${randomUUID()}`;
      const key = softwareKmsP256Key();
      keys.set(keyRef, key);
      return { keyRef, key };
    },
    async key(keyRef) {
      const key = keys.get(keyRef);
      if (key === undefined) {
        throw new Error(`the KMS holds no key ${keyRef}`);
      }
      return key;
    },
  };
}

/** The organiser KMS for an environment. Production refuses until a KMS provider is chosen. */
export function organiserKmsFor(environment: LedgerEnvironment): OrganiserKms {
  switch (environment) {
    case "development":
    case "test":
    // No KMS provider is chosen, so staging uses the software stand-in too: its keys are
    // lost when the process exits, while the ledger service keeps what they signed (T-023-08).
    case "staging":
      return softwareOrganiserKms();
    case "production":
      throw new Error(
        "no KMS provider is chosen for organiser keys; kippu-api cannot exercise organiser " +
          "authority in production",
      );
  }
}
