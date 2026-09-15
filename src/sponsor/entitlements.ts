/**
 * Entitlements: which signed inputs the relay sponsors (`REQ-SP-3`; `F-023`
 * plan §5.3).
 *
 * Sponsorship is an entitlement, not a credit line. Every sponsored input is
 * attributable to one — an event owned, a ticket held, an account being created
 * — decided from ledger facts in the derived copy. Whatever the relay decides,
 * the ledger's rules still decide the write (`REQ-IX-1`, `AD-25`).
 *
 * **The signer is verified first** (`T-023-09`, as ruled in `M1`). The account an
 * input names is its signer only if the authorisation verifies, with the V0
 * profile, against a credential registration of that account in the derived copy
 * — or, for an account's first registration, against the registration it
 * carries, as the ledger's rules do. A forged or unregistered authorisation is
 * refused before any entitlement is looked at, so it neither obtains a
 * sponsorship nor counts against another account's rate limit. A registration the
 * copy has not read yet is a refusal the lag-aware retry resolves (`REQ-SP-5`).
 *
 * | Input | Entitled when |
 * |---|---|
 * | An organiser command on an event | Its signer owns the event |
 * | `createEvent` | Its signer is a Kippu organiser account, and the event id derives from it |
 * | `issueTicket` | Signed by the event's owner |
 * | `transferTicket` | Signed by the ticket's holder, and the ticket is not `cannot_transfer` |
 * | `registerCredential` | Always, within the registration rate limit per account |
 * | An access pass | Its ticket exists and its event is neither `Cancelled` nor `Finished` |
 *
 * The sponsor holds no issuance right and signs nothing as an organiser or a
 * holder (`REQ-SP-2`): a sponsorship authorises nothing on the ledger, it only
 * undertakes to bear the input's cost.
 */
import { eventId } from "@ticketto/profile-v0";
import type {
  AccountId,
  Command,
  CommandKind,
  EventId,
  Profile,
  SignedAccessPass,
  SignedCommand,
} from "@ticketto/sdk";
import type { DerivedQueries } from "../derived/queries.js";
import type { OrganiserAccounts } from "./derived.js";

/** What makes an input entitled, for the record every sponsorship keeps (`F-023` §5.5). */
export type Entitlement =
  | { readonly kind: "eventOwned"; readonly event: EventId; readonly owner: AccountId }
  | { readonly kind: "eventCreated"; readonly event: EventId; readonly creator: AccountId }
  | { readonly kind: "ticketHeld"; readonly ticket: string; readonly holder: AccountId }
  | { readonly kind: "accountCreation"; readonly account: AccountId }
  | { readonly kind: "passTicketLive"; readonly ticket: string; readonly event: EventId };

export type EntitlementDecision =
  | { readonly entitled: true; readonly entitlement: Entitlement }
  | { readonly entitled: false; readonly reason: string };

/** How many registrations the relay sponsors for one account, per window. */
export interface RegistrationRateLimit {
  readonly registrations: number;
  /** In milliseconds. */
  readonly window: number;
}

export interface EntitlementsOptions {
  readonly derived: DerivedQueries;
  /** Kippu organiser ledger accounts, for `createEvent`. */
  readonly organisers: OrganiserAccounts;
  /** The V0 profile, with the deployment's holder RP id: what verifies authorisations. */
  readonly profile: Profile;
  readonly registrationRateLimit: RegistrationRateLimit;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface Entitlements {
  decide(input: SignedCommand | SignedAccessPass): Promise<EntitlementDecision>;
}

const SWEEP_THRESHOLD = 10_000;

const refuse = (reason: string): EntitlementDecision => ({ entitled: false, reason });

/** Commands an event's owner signs, other than `createEvent` and `issueTicket`. */
const EVENT_OWNER_COMMANDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  "setEventStatus",
  "setEventCapacity",
  "addZone",
  "removeZone",
  "removeRestriction",
]);

export function createEntitlements(options: EntitlementsOptions): Entitlements {
  const { derived, organisers, profile, registrationRateLimit } = options;
  const now = options.now ?? Date.now;
  if (
    !Number.isSafeInteger(registrationRateLimit.registrations) ||
    registrationRateLimit.registrations < 1 ||
    !Number.isSafeInteger(registrationRateLimit.window) ||
    registrationRateLimit.window < 1
  ) {
    throw new RangeError("the registration rate limit needs a positive count and window");
  }
  /** Sponsored registrations per account, by when they were sponsored. */
  const registrations = new Map<AccountId, number[]>();

  /** Forgets accounts with no registration inside the window, so the map stays bounded by traffic. */
  const sweep = (at: number) => {
    if (registrations.size < SWEEP_THRESHOLD) return;
    for (const [account, times] of registrations) {
      if (times.every((time) => time <= at - registrationRateLimit.window)) {
        registrations.delete(account);
      }
    }
  };

  /**
   * The account that signed `input`, if its authorisation verifies against a
   * registration of that account (`REQ-CP-6`), as the ledger's rules verify it.
   */
  const verifiedSigner = async (
    input: SignedCommand | SignedAccessPass,
  ): Promise<{ ok: true; account: AccountId } | { ok: false; reason: string }> => {
    const claimed = profile.accountOf(input.authorisation);
    if (!claimed.ok) return { ok: false, reason: "the authorisation names no account" };
    const { account, credential } = claimed.value;
    const payload =
      "command" in input ? profile.encodeCommand(input.command) : profile.encodePass(input.pass);

    // An account's first registration is authorised by the credential it registers.
    if ("command" in input && input.command.kind === "registerCredential") {
      const { command } = input;
      if (command.account === account) {
        const registered = await derived.credentials(account);
        if (registered.result.length === 0) {
          const named = profile.registrationAccount(command.registration);
          if (
            named.ok &&
            named.value.account === account &&
            named.value.credential === credential &&
            profile.verify(command.registration, payload, input.authorisation)
          ) {
            return { ok: true, account };
          }
          return {
            ok: false,
            reason: "a first registration must be authorised by the credential it registers",
          };
        }
      }
    }

    const registration = await derived.credential(account, credential);
    if (registration.result === null) {
      return {
        ok: false,
        reason: "the authorising credential is not registered to its account in the derived copy",
      };
    }
    if (!profile.verify(registration.result.value, payload, input.authorisation)) {
      return { ok: false, reason: "the authorisation does not verify" };
    }
    return { ok: true, account };
  };

  const ownedBy = async (event: EventId, signer: AccountId): Promise<EntitlementDecision> => {
    const read = await derived.event(event);
    if (read.result === null) return refuse(`no event ${event} in the derived copy`);
    const { owner } = read.result.value;
    if (owner !== signer) return refuse(`the signer does not own event ${event}`);
    return { entitled: true, entitlement: { kind: "eventOwned", event, owner } };
  };

  const decideCommand = async (command: Command, signer: AccountId) => {
    if (EVENT_OWNER_COMMANDS.has(command.kind) && "event" in command) {
      return ownedBy(command.event, signer);
    }
    switch (command.kind) {
      case "createEvent": {
        if (eventId(signer, command.salt) !== command.event) {
          return refuse("the event id does not derive from the signer");
        }
        if (!(await organisers.isOrganiserAccount(signer))) {
          return refuse("the signer is not a Kippu organiser account");
        }
        return {
          entitled: true,
          entitlement: { kind: "eventCreated", event: command.event, creator: signer },
        } as const;
      }
      case "issueTicket":
        return ownedBy(command.event, signer);
      case "transferTicket": {
        const read = await derived.ticket(command.ticket);
        const ticket = read.result?.value;
        if (ticket === undefined || ticket.event !== command.event) {
          return refuse(
            `no ticket ${command.ticket} of event ${command.event} in the derived copy`,
          );
        }
        if (ticket.holder !== signer) return refuse("the signer does not hold the ticket");
        if (ticket.restrictions.cannotTransfer) return refuse("the ticket cannot be transferred");
        return {
          entitled: true,
          entitlement: { kind: "ticketHeld", ticket: ticket.id, holder: signer },
        } as const;
      }
      case "registerCredential": {
        const at = now();
        sweep(at);
        const recent = (registrations.get(command.account) ?? []).filter(
          (time) => time > at - registrationRateLimit.window,
        );
        if (recent.length >= registrationRateLimit.registrations) {
          registrations.set(command.account, recent);
          return refuse("too many registrations sponsored for this account; try again later");
        }
        registrations.set(command.account, [...recent, at]);
        return {
          entitled: true,
          entitlement: { kind: "accountCreation", account: command.account },
        } as const;
      }
      default:
        return refuse(`no entitlement covers ${command.kind}`);
    }
  };

  return {
    async decide(input) {
      const verified = await verifiedSigner(input);
      if (!verified.ok) return refuse(verified.reason);
      const signer = verified.account;
      if ("command" in input) return decideCommand(input.command, signer);
      const read = await derived.ticket(input.pass.ticket);
      const ticket = read.result?.value;
      if (ticket === undefined) return refuse(`no ticket ${input.pass.ticket} in the derived copy`);
      const event = await derived.event(ticket.event);
      const status = event.result?.value.status;
      if (status === undefined) return refuse(`no event ${ticket.event} in the derived copy`);
      if (status === "Cancelled" || status === "Finished") {
        return refuse(`event ${ticket.event} is ${status}`);
      }
      return {
        entitled: true,
        entitlement: { kind: "passTicketLive", ticket: ticket.id, event: ticket.event },
      };
    },
  };
}
