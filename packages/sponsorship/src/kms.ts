// The sponsor's key: a `p256` key held in a KMS (features/023-sponsorship/plan.md
// §5.2), behind the SDK's `Signer` interface.
//
// A KMS never releases the secret key; it signs a digest. `KmsP256Key` is the
// narrow surface a provider adapter implements — the compressed public key, and
// ECDSA P-256 over a 32-byte digest — and `kmsP256Signer` turns it into the
// profile's `p256` authorisation: ECDSA P-256 over `BLAKE2b-256(payload)`, with
// low S, plus the public key (C2).
//
// No KMS provider is chosen. A managed provider's adapter plugs in here; until
// then the software key in `@kippurocks/sponsorship/testing` stands in for it.

import { p256 } from "@noble/curves/nist.js";
import {
  encodeAuthorisation,
  normaliseP256Signature,
  p256AccountId,
  p256AuthorisationDigest,
} from "@ticketto/profile-v0";
import type { Authorisation, Signer } from "@ticketto/sdk";

/** An ECDSA P-256 signature as a KMS returns it. */
export interface KmsSignature {
  readonly signature: Uint8Array;
  /** `der`, as most KMS services return it, or 64-byte `r ‖ s`. */
  readonly format: "der" | "compact";
}

/** A `p256` key held in a KMS. */
export interface KmsP256Key {
  /** The compressed SEC1 public key, 33 bytes. */
  readonly publicKey: Uint8Array;
  /** ECDSA P-256 over `digest`, 32 bytes, signed as a digest — never hashed again. */
  signDigest(digest: Uint8Array): Promise<KmsSignature>;
}

/**
 * The SDK `Signer` for a `p256` KMS key: the sponsor account's signer. Its
 * account is the profile's `p256` account of the key. A signature that does not
 * verify under the key's public key is refused, so a misconfigured key fails
 * here rather than at the ledger service.
 */
export function kmsP256Signer(key: KmsP256Key): Signer {
  const publicKey = key.publicKey.slice();
  const account = p256AccountId(publicKey);
  return {
    account,
    async sign(payload: Uint8Array): Promise<Authorisation> {
      const digest = p256AuthorisationDigest(payload);
      const { signature, format } = await key.signDigest(digest);
      const normalised = normaliseP256Signature(signature, format);
      if (!p256.verify(normalised, digest, publicKey, { prehash: false, lowS: true })) {
        throw new Error("the KMS signature does not verify under the key's public key");
      }
      return encodeAuthorisation({ kind: "p256", publicKey, signature: normalised });
    },
  };
}
