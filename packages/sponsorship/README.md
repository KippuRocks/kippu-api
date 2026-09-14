# @kippu/sponsorship

Sponsorships for Kippu's sponsor relay (`F-023`, `T-023-01`): the sponsor's
signed undertaking to relay one signed command or signed access pass and bear
its cost (`REQ-SP-1`, `AD-18` A). The hosted ledger service verifies them before
any rule runs (`F-010` §5.3); the relay issues them.

Nothing is published to a registry. Consumers in other repositories install a
`pnpm pack` tarball pinned to a recorded commit of this repository, as
`ticketto-offchain` vendors `libticketto`.

## Format

```
Sponsorship     = version u8, input kind u8, bound id [u8;16],
                  notional cost Compact<u128>, authorisation Vec<u8>
Signing payload = "kippu/v0/sponsorship" ‖ version, input kind, bound id, notional cost
```

| Field | Value |
|---|---|
| version | `0` |
| input kind | The profile's signed-input kind: `0` command, `1` access pass |
| bound id | A command's operation id; a pass's pass id (a pass's operation id is its pass id, `AD-15`) |
| notional cost | In the unit of the notional cost table (`F-023` §5.5). Nil under the MVP backend (`REQ-SP-1b`) |
| authorisation | The V0 profile's `p256` authorisation over the signing payload (`C2`) |

SCALE throughout; decoding accepts only the canonical encoding.

## Use

```ts
import { issueSponsorship, kmsP256Signer, verifySponsorship } from "@kippu/sponsorship";

const sponsor = kmsP256Signer(key); // the sponsor's p256 KMS key
const sponsorship = await issueSponsorship(sponsor, signedInput, { notionalCost: 0n });

// In the ledger service, configured with the sponsor accounts it accepts:
const result = verifySponsorship(sponsorship, signedInput, { sponsors: [sponsor.account] });
// { ok: true, value: { sponsor, notionalCost } } or ERR-SponsorshipRefused
```

`verifySponsorship` refuses, with `ERR-SponsorshipRefused`, bytes that are not a
sponsorship, a sponsorship bound to another operation id or pass id, one whose
authorisation is not `p256`, one signed by an account that is not configured,
and one whose signature does not verify.

## The sponsor's key

`KmsP256Key` is the surface a KMS provider adapter implements: the compressed
public key, and ECDSA P-256 over a 32-byte digest. `kmsP256Signer` turns it into
the SDK's `Signer`, normalising DER and high-S signatures and refusing one that
does not verify under the key.

**No KMS provider is chosen yet.** A managed provider's adapter implements
`KmsP256Key`; nothing else changes. Until then, `softwareKmsP256Key` from
`@kippu/sponsorship/testing` stands in for it in development and tests. Its
secret key is plain bytes in memory: never use it for a deployed sponsor.
