/**
 * Entitlements: which signed inputs the relay sponsors (`REQ-SP-3`; `F-023`
 * plan §5.3).
 *
 * Sponsorship is an entitlement, not a credit line. Every sponsored input is
 * attributable to one — an event owned, a ticket held, an account being created
 * — decided from ledger facts in the derived copy. Whatever the relay decides,
 * the ledger's rules still decide the write (`REQ-IX-1`, `AD-25`): the copy can
 * only wrongly refuse, never wrongly grant a write.
 *
 * | Input | Entitled when |
 * |---|---|
 * | An organiser command on an event | Its signer owns the event |
 * | `createEvent` | Its signer is the event's creator: the event id derives from the signer |
 * | `issueTicket` | Signed by the event's owner |
 * | `transferTicket` | Signed by the ticket's holder, and the ticket is not `cannot_transfer` |
 * | `registerCredential` | Always, within the registration rate limit per account |
 * | An access pass | Its ticket exists and its event is neither `Cancelled` nor `Finished` |
 *
 * The signer is the account the input's authorisation names (`accountOf`).
 * The relay does not verify the authorisation: that is the ledger's rule
 * (`AD-25`), and the relay has no credential registrations to verify it with.
 *
 * The sponsor holds no issuance right and signs nothing as an organiser or a
 * holder (`REQ-SP-2`): a sponsorship authorises nothing on the ledger, it only
 * undertakes to bear the input's cost.
 */
import { accountOf, eventId } from "@ticketto/profile-v0";
import type {
  AccountId,
  Command,
  CommandKind,
  EventId,
  SignedAccessPass,
  SignedCommand,
} from "@ticketto/sdk";
import type { DerivedQueries } from "../derived/queries.js";

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

function signerOf(input: SignedCommand | SignedAccessPass): AccountId | null {
  const claimed = accountOf(input.authorisation);
  return claimed.ok ? claimed.value.account : null;
}

export function createEntitlements(options: EntitlementsOptions): Entitlements {
  const { derived, registrationRateLimit } = options;
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
      const signer = signerOf(input);
      if (signer === null) return refuse("the authorisation names no account");
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
