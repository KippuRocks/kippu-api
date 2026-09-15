import { type KmsP256Key, kmsP256Signer } from "@kippu/sponsorship";
import {
  encodeRegistration,
  normaliseP256Signature,
  p256AccountId,
  p256RegistrationDigest,
  registrationAccount,
} from "@ticketto/profile-v0";
import type { AccountId, Derived, Receipt, Registration, Signer, Submission } from "@ticketto/sdk";
import { AuditError, type AuditLog, type RelayRequest } from "../audit/audit-log.js";
import { commandOfSigningPayload, relay } from "../audit/relay.js";
import type { KippuTicketto } from "../ledger/ticketto.js";
import type { Store } from "../store/store.js";
import { SpecCodeError } from "./errors.js";
import type { OrganiserKms } from "./kms.js";

/**
 * The SDK `Signer` for an organiser's KMS key, which refuses to reach the KMS
 * unless the command it is asked to sign already has a pending audit row
 * (`NFR-7`; `F-021` plan §5.1).
 *
 * `relay` writes that row through its audited signer before this signer runs,
 * so every relayed write passes. Anything that reaches the key another way —
 * bytes that are not a command, or a command nobody recorded — fails here, and
 * the KMS is never called: a signature by an organiser's key exists only with a
 * prior audit row.
 */
export function organiserSigner(key: KmsP256Key, audit: AuditLog): Signer {
  const kms = kmsP256Signer(key);
  return {
    account: kms.account,
    async sign(payload) {
      const command = commandOfSigningPayload(payload);
      if (command === null) {
        throw new AuditError("refusing to sign a payload that is not a command");
      }
      const row = await audit.find(command.operationId);
      if (row === null || row.outcome !== "pending" || row.commandKind !== command.kind) {
        throw new AuditError(
          `refusing to sign operation ${command.operationId}: it has no pending audit row`,
        );
      }
      return kms.sign(payload);
    },
  };
}

/** A write the SDK returns: a submission, or a derived identifier with its submission. */
type Write = Submission<Receipt> | Derived<unknown>;

/**
 * Organisers' authority over their events on the ledger, held and exercised by
 * Kippu on their behalf (`REQ-OA-1`, `AC-A2.1`). Organisers never handle ledger
 * credentials (`US-A2`).
 */
export interface OrganiserAuthority {
  /** The organiser's ledger account, or `null` when none has been provisioned. */
  account(organiserId: string): Promise<AccountId | null>;
  /**
   * The organiser's ledger account, provisioned first if need be: a `p256` key
   * of their own in the KMS, whose self-registration the ledger has accepted
   * (`REQ-CP-6`). The registration is relayed, and audited, on behalf of `request`.
   */
  provision(organiserId: string, request: RelayRequest): Promise<AccountId>;
  /**
   * Relays one ledger write signed with the organiser's authority, on behalf of
   * `request`. `write` receives the organiser's audited signer and performs the
   * SDK call with it; the audit row is written before the KMS is asked to sign.
   */
  relay<W extends Write>(
    organiserId: string,
    request: RelayRequest,
    write: (signer: Signer) => W,
  ): Promise<W>;
}

export interface OrganiserAuthorityOptions {
  readonly store: Store;
  readonly kms: OrganiserKms;
  readonly audit: AuditLog;
  readonly ledger: Pick<KippuTicketto, "registerCredential">;
  readonly now?: () => Date;
  /** Passed to `relay`: called when a write's outcome could not be added to its audit row. */
  readonly onAuditFailure?: (error: unknown) => void;
}

interface AccountRow {
  readonly kms_key_ref: string;
  readonly account: string;
  readonly registration: Buffer | null;
  readonly registered_at: Date | null;
}

const SELECT_ACCOUNT = `SELECT kms_key_ref, account, registration, registered_at
  FROM organiser_ledger_accounts WHERE organiser_id = $1`;

/** The key's self-registration: its public key, signed by itself (`F-003` plan §5.7). */
async function signRegistration(key: KmsP256Key): Promise<Registration> {
  const { signature, format } = await key.signDigest(p256RegistrationDigest(key.publicKey));
  const registration = encodeRegistration({
    kind: "p256",
    publicKey: key.publicKey,
    signature: normaliseP256Signature(signature, format),
  });
  const named = registrationAccount(registration);
  if (!named.ok || named.value.account !== p256AccountId(key.publicKey)) {
    throw new Error("the KMS signature does not verify under the key's public key");
  }
  return registration;
}

export function createOrganiserAuthority(options: OrganiserAuthorityOptions): OrganiserAuthority {
  const { store, kms, audit, ledger, now = () => new Date() } = options;
  const relayOptions = (request: RelayRequest) => ({
    audit,
    request,
    ...(options.onAuditFailure === undefined ? {} : { onAuditFailure: options.onAuditFailure }),
  });
  const keys = new Map<string, KmsP256Key>();

  const keyOf = async (keyRef: string): Promise<KmsP256Key> => {
    let key = keys.get(keyRef);
    if (key === undefined) {
      key = await kms.key(keyRef);
      keys.set(keyRef, key);
    }
    return key;
  };

  const read = async (organiserId: string): Promise<AccountRow | null> =>
    (await store.query<AccountRow>(SELECT_ACCOUNT, [organiserId])).rows[0] ?? null;

  /**
   * The organiser's row, with a KMS key created for it if it had none. Creation
   * holds the organiser's row, so concurrent first requests create one key.
   */
  const accountRow = async (organiserId: string, request: RelayRequest): Promise<AccountRow> => {
    const existing = await read(organiserId);
    if (existing !== null) {
      return existing;
    }
    const client = await store.connect();
    try {
      await client.query("BEGIN");
      const organiser = await client.query(
        "SELECT id FROM organisers WHERE id = $1 FOR NO KEY UPDATE",
        [organiserId],
      );
      if (organiser.rowCount !== 1) {
        throw new Error(`no organiser ${organiserId}`);
      }
      let row = (await client.query<AccountRow>(SELECT_ACCOUNT, [organiserId])).rows[0];
      if (row === undefined) {
        const { keyRef, key } = await kms.createKey(organiserId);
        keys.set(keyRef, key);
        const account = p256AccountId(key.publicKey);
        const { principal } = request;
        await client.query(
          `INSERT INTO organiser_ledger_accounts
             (organiser_id, kms_key_ref, public_key, account, provisioned_request_id,
              provisioned_principal_kind, provisioned_session_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            organiserId,
            keyRef,
            Buffer.from(key.publicKey),
            account,
            request.requestId,
            principal.kind,
            "sessionId" in principal ? principal.sessionId : null,
            now(),
          ],
        );
        row = { kms_key_ref: keyRef, account, registration: null, registered_at: null };
      }
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const provision = async (organiserId: string, request: RelayRequest): Promise<AccountId> => {
    let row = await accountRow(organiserId, request);
    if (row.registered_at !== null) {
      return row.account as AccountId;
    }
    const key = await keyOf(row.kms_key_ref);

    // The self-registration is signed only now that the row attributing the key exists.
    if (row.registration === null) {
      const registration = await signRegistration(key);
      await store.query(
        `UPDATE organiser_ledger_accounts SET registration = $2, registration_signed_at = $3
         WHERE organiser_id = $1 AND registration IS NULL`,
        [organiserId, Buffer.from(registration), now()],
      );
      row = (await read(organiserId)) as AccountRow;
    }

    const account = row.account as AccountId;
    const registration = Uint8Array.from(row.registration as Buffer) as Registration;
    // Registering an already registered credential is accepted and changes nothing, so
    // concurrent first requests may both submit it.
    const result = await relay(relayOptions(request), organiserSigner(key, audit), (signer) =>
      ledger.registerCredential(signer, { account, registration }),
    );
    if (!result.ok) {
      throw new SpecCodeError(result.error.code, result.error.detail);
    }
    await store.query(
      `UPDATE organiser_ledger_accounts SET registered_at = $2
       WHERE organiser_id = $1 AND registered_at IS NULL`,
      [organiserId, now()],
    );
    return account;
  };

  return {
    async account(organiserId) {
      const row = await read(organiserId);
      return row === null ? null : (row.account as AccountId);
    },

    provision,

    async relay(organiserId, request, write) {
      await provision(organiserId, request);
      const row = (await read(organiserId)) as AccountRow;
      const key = await keyOf(row.kms_key_ref);
      return relay(relayOptions(request), organiserSigner(key, audit), write);
    },
  };
}
