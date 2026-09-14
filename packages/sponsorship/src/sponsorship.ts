// Sponsorships: the sponsor's signed undertaking to relay one signed input and
// bear its cost (REQ-SP-1, AD-18 A; features/023-sponsorship/plan.md §5.2).
//
//   Sponsorship     = version u8, input kind u8, bound id [u8;16], input digest [u8;32],
//                     notional cost Compact<u128>, authorisation Vec<u8>
//   Signing payload = "kippu/v0/sponsorship" ‖ version, input kind, bound id, input digest,
//                     notional cost
//
// | input kind | input               | bound id                   |
// |------------|---------------------|----------------------------|
// | 0          | signed command      | the envelope's operation id |
// | 1          | signed access pass  | the pass id                |
//
// The input kinds are the profile's signed-input kinds (`SIGNED_INPUT_KIND_INDEX`),
// so an operation id and a pass id that happen to be equal never share a
// sponsorship. The input digest is the one C3 records for replay: BLAKE2b-256 of
// the profile's signed-input framing. Binding it as well as the id means a
// sponsorship for one input cannot be attached to a different input that reuses
// its id (REQ-SP-3; features/023-sponsorship/plan.md §5.2). The authorisation is the profile's `p256` authorisation (C2) over
// the signing payload, by a configured sponsor account. The notional cost is in
// the unit of the notional cost table (§5.5); it is nil under the MVP backend,
// and carried anyway so that the path is exercised and metered (REQ-SP-1b).
//
// Decoding is strict: only the canonical encoding of a value is accepted.

import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  blake2b256,
  DecodeError,
  decodeAuthorisation,
  encodeSignedAccessPass,
  encodeSignedCommand,
  p256AccountId,
  p256AuthorisationDigest,
  SIGNED_INPUT_KIND_INDEX,
} from "@ticketto/profile-v0";
import type {
  AccountId,
  Authorisation,
  OperationId,
  PassId,
  Result,
  SignedAccessPass,
  SignedCommand,
  Signer,
  Sponsorship,
} from "@ticketto/sdk";
import { Bytes, compact, Struct, u8 } from "scale-ts";

/** The format version a sponsorship starts with, so a later revision can be told apart. */
export const SPONSORSHIP_FORMAT_VERSION = 0;

/** The domain tag of what a sponsor signs. No Ticketto signing payload starts with it. */
export const SPONSORSHIP_SIGNING_TAG: Uint8Array = new TextEncoder().encode("kippu/v0/sponsorship");

/** Bytes in an operation id or a pass id. */
export const BOUND_ID_LENGTH = 16;

/** Bytes in a signed input's digest. */
export const INPUT_DIGEST_LENGTH = 32;

const MAX_NOTIONAL_COST = (1n << 128n) - 1n;

/** What a sponsor relays: a signed command or a signed access pass (`Sponsor.sponsor`). */
export type SponsoredInput = SignedCommand | SignedAccessPass;

/**
 * The input a sponsorship is bound to: a command's operation id, or a pass's id,
 * and the digest of the signed input itself (`signedInputDigest`).
 */
export type SponsorshipTarget =
  | { readonly kind: "command"; readonly operationId: OperationId; readonly digest: Uint8Array }
  | { readonly kind: "accessPass"; readonly passId: PassId; readonly digest: Uint8Array };

/** A sponsorship's contents. */
export interface SponsorshipValue {
  readonly target: SponsorshipTarget;
  /** In the notional cost table's unit; `0n` under the MVP backend (`REQ-SP-1b`). */
  readonly notionalCost: bigint;
  /** The sponsor's `p256` authorisation over the signing payload. */
  readonly authorisation: Authorisation;
}

interface Frame {
  version: number;
  kind: number;
  id: Uint8Array;
  digest: Uint8Array;
  cost: number | bigint;
}

const unsignedCodec = Struct({
  version: u8,
  kind: u8,
  id: Bytes(BOUND_ID_LENGTH),
  digest: Bytes(INPUT_DIGEST_LENGTH),
  cost: compact,
});
const sponsorshipCodec = Struct({
  version: u8,
  kind: u8,
  id: Bytes(BOUND_ID_LENGTH),
  digest: Bytes(INPUT_DIGEST_LENGTH),
  cost: compact,
  authorisation: Bytes(),
});

/**
 * The digest of a signed input, as `C3` records it for replay: BLAKE2b-256 of the
 * profile's signed-input framing.
 */
export function signedInputDigest(input: SponsoredInput): Uint8Array {
  return blake2b256("pass" in input ? encodeSignedAccessPass(input) : encodeSignedCommand(input));
}

/** The operation id or pass id `input` carries, and its digest. */
export function sponsorshipTarget(input: SponsoredInput): SponsorshipTarget {
  const digest = signedInputDigest(input);
  return "pass" in input
    ? { kind: "accessPass", passId: input.pass.id, digest }
    : { kind: "command", operationId: input.command.operationId, digest };
}

function frameOf(target: SponsorshipTarget, notionalCost: bigint): Frame {
  if (typeof notionalCost !== "bigint" || notionalCost < 0n || notionalCost > MAX_NOTIONAL_COST) {
    throw new TypeError("expected a notional cost between 0 and 2^128 - 1");
  }
  const [kind, hex] =
    target.kind === "command"
      ? [SIGNED_INPUT_KIND_INDEX.command, target.operationId]
      : [SIGNED_INPUT_KIND_INDEX.accessPass, target.passId];
  const id = boundId(hex);
  if (!(target.digest instanceof Uint8Array) || target.digest.length !== INPUT_DIGEST_LENGTH) {
    throw new TypeError(`expected a ${INPUT_DIGEST_LENGTH}-byte input digest`);
  }
  return {
    version: SPONSORSHIP_FORMAT_VERSION,
    kind,
    id,
    digest: target.digest,
    cost: notionalCost,
  };
}

function boundId(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(hex)) throw new TypeError("expected a lower-case hex id");
  const id = hexToBytes(hex);
  if (id.length !== BOUND_ID_LENGTH) throw new TypeError(`expected a ${BOUND_ID_LENGTH}-byte id`);
  return id;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The bytes a sponsor signs for a sponsorship of `target` at `notionalCost`. */
export function sponsorshipSigningPayload(
  target: SponsorshipTarget,
  notionalCost: bigint,
): Uint8Array {
  return concat(SPONSORSHIP_SIGNING_TAG, unsignedCodec.enc(frameOf(target, notionalCost)));
}

/** The canonical encoding of a sponsorship. */
export function encodeSponsorship(value: SponsorshipValue): Sponsorship {
  if (!(value.authorisation instanceof Uint8Array))
    throw new TypeError("expected authorisation bytes");
  const frame = frameOf(value.target, value.notionalCost);
  return sponsorshipCodec.enc({ ...frame, authorisation: value.authorisation }) as Sponsorship;
}

/** The sponsorship `bytes` encode. Throws `DecodeError` for anything but a canonical encoding. */
export function decodeSponsorship(bytes: Uint8Array): SponsorshipValue {
  let value: SponsorshipValue;
  try {
    // A copy: scale-ts reads from the underlying buffer, ignoring a view's offset.
    const frame = sponsorshipCodec.dec(bytes.slice());
    if (frame.version !== SPONSORSHIP_FORMAT_VERSION) {
      throw new DecodeError(`unsupported sponsorship format version ${frame.version}`);
    }
    const hex = bytesToHex(frame.id);
    let target: SponsorshipTarget;
    if (frame.kind === SIGNED_INPUT_KIND_INDEX.command) {
      target = { kind: "command", operationId: hex as OperationId, digest: frame.digest };
    } else if (frame.kind === SIGNED_INPUT_KIND_INDEX.accessPass) {
      target = { kind: "accessPass", passId: hex as PassId, digest: frame.digest };
    } else {
      throw new DecodeError(`unknown sponsored input kind ${frame.kind}`);
    }
    value = {
      target,
      notionalCost: BigInt(frame.cost),
      authorisation: frame.authorisation as Authorisation,
    };
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(error instanceof Error ? error.message : String(error));
  }
  // Only the canonical encoding: no trailing bytes, truncation or non-minimal compact integer.
  let reencoded: Uint8Array;
  try {
    reencoded = encodeSponsorship(value);
  } catch (error) {
    throw new DecodeError(error instanceof Error ? error.message : String(error));
  }
  if (!equalBytes(reencoded, bytes)) {
    throw new DecodeError("not the canonical encoding of a sponsorship");
  }
  return value;
}

/** What issuing a sponsorship needs beyond the input. */
export interface IssueOptions {
  /** In the notional cost table's unit (`REQ-SP-1b`). */
  readonly notionalCost: bigint;
}

/**
 * A sponsorship of `input`, signed by `sponsor` — the sponsor account's `p256`
 * signer (`kmsP256Signer`). Deciding whether `input` is entitled to one is the
 * relay's concern, not this function's (`REQ-SP-3`).
 */
export async function issueSponsorship(
  sponsor: Signer,
  input: SponsoredInput,
  options: IssueOptions,
): Promise<Sponsorship> {
  const target = sponsorshipTarget(input);
  const authorisation = await sponsor.sign(sponsorshipSigningPayload(target, options.notionalCost));
  return encodeSponsorship({ target, notionalCost: options.notionalCost, authorisation });
}

/** What verifying a sponsorship needs beyond the bytes. */
export interface VerifyOptions {
  /** The sponsor accounts this deployment accepts sponsorships from. */
  readonly sponsors: Iterable<AccountId>;
}

/** A verified sponsorship: who sponsored, and at what notional cost. */
export interface VerifiedSponsorship {
  readonly sponsor: AccountId;
  readonly notionalCost: bigint;
}

function refused(detail: string): Result<never> {
  return { ok: false, error: { code: "ERR-SponsorshipRefused", detail } };
}

function sameId(a: SponsorshipTarget, b: SponsorshipTarget): boolean {
  if (a.kind === "command" && b.kind === "command") return a.operationId === b.operationId;
  if (a.kind === "accessPass" && b.kind === "accessPass") return a.passId === b.passId;
  return false;
}

/**
 * Whether `sponsorship` is a valid sponsorship of `input`: canonically encoded,
 * bound to `input`'s operation id — for a pass, its pass id — and to its
 * digest, and signed with
 * a `p256` authorisation by one of `options.sponsors`. Anything else fails with
 * `ERR-SponsorshipRefused`, as the hosted ledger service refuses it before any
 * rule runs (`F-010` §5.3).
 */
export function verifySponsorship(
  sponsorship: Uint8Array,
  input: SponsoredInput,
  options: VerifyOptions,
): Result<VerifiedSponsorship> {
  let value: SponsorshipValue;
  try {
    value = decodeSponsorship(sponsorship);
  } catch (error) {
    return refused(`malformed sponsorship: ${String(error)}`);
  }
  const target = sponsorshipTarget(input);
  if (!sameId(value.target, target)) {
    return refused("the sponsorship is bound to another operation id or pass id");
  }
  if (!equalBytes(value.target.digest, target.digest)) {
    return refused("the sponsorship is bound to another input with the same id");
  }
  let signed: ReturnType<typeof decodeAuthorisation>;
  try {
    signed = decodeAuthorisation(value.authorisation);
  } catch (error) {
    return refused(`malformed sponsor authorisation: ${String(error)}`);
  }
  if (signed.kind !== "p256") return refused("the sponsor authorisation is not a p256 one");
  let sponsor: AccountId;
  try {
    sponsor = p256AccountId(signed.publicKey);
  } catch {
    return refused("the sponsor authorisation carries no p256 public key");
  }
  if (!new Set(options.sponsors).has(sponsor)) {
    return refused("the sponsorship is not signed by a configured sponsor account");
  }
  const digest = p256AuthorisationDigest(
    sponsorshipSigningPayload(value.target, value.notionalCost),
  );
  let valid: boolean;
  try {
    valid = p256.verify(signed.signature, digest, signed.publicKey, {
      prehash: false,
      lowS: true,
    });
  } catch {
    valid = false;
  }
  if (!valid) return refused("the sponsor's signature does not verify");
  return { ok: true, value: { sponsor, notionalCost: value.notionalCost } };
}
