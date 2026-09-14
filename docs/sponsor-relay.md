# Sponsor relay API — v0

The sponsor relay issues sponsorships: Kippu's signed undertaking to bear the
ledger cost of one signed command or signed access pass (`REQ-SP-1`, `AD-18` A).
The hosted ledger service refuses any write without a valid one, so every
Ticketto client that writes needs this API, and gets it as **plain HTTP and
JSON** — no tRPC, no Kippu account, no SDK beyond the profile that signs the
input (`AD-07`, §13).

Sponsorship is an entitlement, not a credit line (`REQ-SP-3`): the relay
sponsors an input only when a ledger fact entitles it. A client never sees a
fee, a balance or a funding step (`REQ-SP-1a`).

Design: `features/023-sponsorship/plan.md` in `KippuRocks/kippu-docs`.
Implementation: `src/sponsor/` in this repository.

## 1. Conventions

- **Versioning.** Endpoints live under `/v0`. A change that breaks a v0 client
  is a new version, served side by side. `GET /health` is operational and
  unversioned.
- **Bodies** are JSON (`Content-Type: application/json`), UTF-8.
- **Bytes** travel as lower-case hexadecimal strings of even length, with no
  prefix — as the ledger service's wire protocol (`C4`) carries them.
- **Authentication:** none. What the relay sponsors is decided by the signed
  input and ledger facts, not by who asks. Deployments serve it over TLS.

## 2. `POST /v0/sponsor`

### Request

```json
{
  "input": { "kind": "command" | "pass", "bytes": "<hex>" },
  "after": "<cursor>"
}
```

| Field | Rule |
|---|---|
| `input.kind` | `"command"` for a signed command, `"pass"` for a signed access pass |
| `input.bytes` | The V0 profile's signed-input framing of the input: `encodeSignedCommand` or `encodeSignedAccessPass` from `@ticketto/profile-v0`. The same bytes the ledger service's `POST /v0/submit` takes |
| `after` | Optional. A log cursor: the receipt cursor of the write that gave rise to this input's entitlement — for example the issuance or transfer that made the signer the holder. At most 128 characters from `A–Z a–z 0–9 . _ ~ -` |

### Responses

| Status | Body | Meaning | Retry |
|---|---|---|---|
| `200` | `{ "sponsorship": "<hex>" }` | The sponsorship. Submit it with the input, unchanged | — |
| `400` | `{ "error": { "code": "malformed", "detail" } }` | The body is not of the shape above, `after` is not a cursor, or the profile cannot decode `input.bytes` | No |
| `403` | `{ "error": { "code": "ERR-SponsorshipRefused", "detail" } }` | No entitlement covers the input (§3). `SPEC.md` §10: not retryable | No |
| `503` | `{ "error": { "code": "lagging", "detail" } }`, `Retry-After` | The relay refused, but its copy of ledger facts has not yet reached `after` (§4) | Yes, after `Retry-After` seconds |
| `503` | `{ "error": { "code": "unavailable" } }` | The relay cannot read ledger facts | Yes, with backoff |

`detail` is human-readable and not part of the contract.

### What a sponsorship is

Opaque to clients: pass the bytes through. For implementers, its format is
`@kippu/sponsorship`'s (`packages/sponsorship/README.md`): it binds the input's
operation id — a pass's pass id — and the digest of its signed-input framing,
carries a notional cost, and is signed by a sponsor account the ledger service
is configured to accept. A sponsorship attached to any other input is refused.

## 3. Entitlements

The signer is the account the input's authorisation names; the ledger verifies
the authorisation itself.

| Input | Sponsored when |
|---|---|
| `setEventStatus`, `setEventCapacity`, `addZone`, `removeZone`, `removeRestriction` | The signer owns the event |
| `createEvent` | The event id derives from the signer |
| `issueTicket` | Signed by the event's owner |
| `transferTicket` | Signed by the ticket's holder, and the ticket is not `cannot_transfer` |
| `registerCredential` | Always, within a per-account rate limit |
| An access pass | Its ticket exists, and its event is neither `Cancelled` nor `Finished` |

A sponsorship authorises nothing: the ledger's rules still decide every write.

## 4. Lag

The relay decides from Kippu's copy of ledger facts, which trails the ledger
(`NFR-11`). A lagging copy can refuse an entitled input, never wrongly grant a
write. A client that has just received a ticket — or made any write its next
input depends on — sends that write's receipt cursor as `after`. The relay then
waits a bounded time for its copy to reach it before deciding again, and answers
`503 lagging` rather than refusing if it has not. An entitled input is never
permanently refused (`REQ-SP-5`).

## 5. `GET /health`

`200 { "status": "ok", "sponsor": "<AccountId>", "derived": { "cursor", "records", "lastRecordedAt" } }`
while the relay can read ledger facts, `503 { "status": "unavailable" }`
otherwise. `sponsor` is the account a ledger service configures to accept.

## 6. Example

```ts
import { encodeSignedCommand } from "@ticketto/profile-v0";

const response = await fetch(`${relay}/v0/sponsor`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    input: { kind: "command", bytes: toHex(encodeSignedCommand(signed)) },
  }),
});
if (response.status === 200) {
  const { sponsorship } = await response.json(); // submit with the input
}
```

`fixtures/sponsor-client` is a complete client with no tRPC dependency; CI runs
it against the built relay.
