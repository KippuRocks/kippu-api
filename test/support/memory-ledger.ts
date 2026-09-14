import { createTestMemoryBackend, type TestMemoryBackend } from "@ticketto/backend-memory/testing";
import { createProfileV0 } from "@ticketto/profile-v0";
import {
  type SoftwareCredential,
  simulatedWebAuthnSigner,
  softwareP256Signer,
} from "@ticketto/profile-v0/testing";
import {
  type AccountId,
  type ClassId,
  createTicketto,
  type Discriminator,
  type EventId,
  type Receipt,
  type Result,
  type Signer,
  type Sponsor,
  type Sponsorship,
  type TicketId,
  type Ticketto,
  type ZoneId,
} from "@ticketto/sdk";
import { expect } from "vitest";

/** Placeholder: the real holder RP id is not chosen yet. */
export const HOLDER_RP_ID = "holder.kippu.example";

const sponsor: Sponsor = {
  sponsor: async () => ({ ok: true, value: new Uint8Array() as Sponsorship }),
};

const hex = (length: number, byte: number) => byte.toString(16).padStart(2, "0").repeat(length);

/** A zone id, from one repeated byte. */
export const zoneId = (byte: number) => hex(32, byte) as ZoneId;
/** A class id, from one repeated byte. */
export const classId = (byte: number) => hex(32, byte) as ClassId;

/**
 * A `backend-memory` ledger, and a Ticketto client writing to it directly —
 * not through Kippu. Whatever this client writes, Kippu never sees except
 * through the log (`NFR-11`).
 */
export interface MemoryLedger {
  readonly backend: TestMemoryBackend;
  /** A client of the ledger that bypasses Kippu entirely. */
  readonly direct: Ticketto;
  /** An organiser credential, registered on the ledger by {@link MemoryLedger.registerOrganiser}. */
  readonly organiser: SoftwareCredential;
  registerOrganiser(): Promise<void>;
  /** A holder credential of the pass-webauthn kind, registered on the ledger. */
  registerHolder(seed: number): Promise<Signer>;
  createEvent(salt: number, zones?: readonly ZoneId[], capacity?: number | null): Promise<EventId>;
  /** Issues a granted, single-entry, unrestricted ticket in an unseated zone. */
  issue(event: EventId, zone: ZoneId, discriminator: number, holder: AccountId): Promise<TicketId>;
}

export async function settled(submission: PromiseLike<Result<Receipt>>): Promise<Receipt> {
  const result = await submission;
  if (!result.ok) {
    expect.fail(`the ledger refused a write: ${result.error.code} ${result.error.detail ?? ""}`);
  }
  return result.value;
}

export function memoryLedger(): MemoryLedger {
  const profile = createProfileV0({ rpId: HOLDER_RP_ID });
  const backend = createTestMemoryBackend({ profile });
  const direct = createTicketto({
    backend,
    profile,
    sponsor,
    operationLifetime: 60_000,
    now: () => backend.clock.now(),
    randomBytes: (length) => backend.randomBytes(length),
  });
  const organiser = softwareP256Signer({ secretKey: new Uint8Array(32).fill(0x11) });

  return {
    backend,
    direct,
    organiser,
    async registerOrganiser() {
      await settled(
        direct.registerCredential(organiser.signer, {
          account: organiser.signer.account,
          registration: organiser.registration,
        }),
      );
    },
    async registerHolder(seed) {
      const holder = simulatedWebAuthnSigner({
        rpId: HOLDER_RP_ID,
        secretKey: new Uint8Array(32).fill(seed),
        credentialId: new Uint8Array(16).fill(seed),
      });
      await settled(
        direct.registerCredential(holder.signer, {
          account: holder.signer.account,
          registration: holder.registration,
        }),
      );
      return holder.signer;
    },
    async createEvent(salt, zones = [zoneId(0x7a)], capacity = null) {
      const created = direct.createEvent(organiser.signer, {
        salt: new Uint8Array(16).fill(salt),
        zones: zones.map((id) => ({ id, kind: "Unseated" as const })),
        capacity,
        metadata: null,
      });
      await settled(created.submission);
      return created.id;
    },
    async issue(event, zone, discriminator, holder) {
      const issued = direct.issueTicket(organiser.signer, {
        event,
        zone,
        placement: { kind: "Unseated", discriminator: hex(16, discriminator) as Discriminator },
        class: classId(0xc1),
        provenance: "Granted",
        policy: { kind: "Single" },
        restrictions: { cannotResale: false, cannotTransfer: false },
        holder,
        metadata: null,
      });
      await settled(issued.submission);
      return issued.id;
    },
  };
}
