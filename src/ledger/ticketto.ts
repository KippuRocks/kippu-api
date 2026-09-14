import { createMemoryBackend } from "@ticketto/backend-memory";
import { createProfileV0 } from "@ticketto/profile-v0";
import {
  type Backend,
  type CommandInput,
  type CommandKind,
  createTicketto,
  type Derived,
  type EventId,
  type PassPresentation,
  type Profile,
  type Receipt,
  type SignedAccessPass,
  type Signer,
  type Sponsor,
  type Submission,
  type TicketId,
  type Ticketto,
  type Timestamp,
} from "@ticketto/sdk";
import {
  type Allowed,
  assertAllowed,
  COMMAND_INPUT_ALLOW_LIST,
  PASS_ALLOW_LIST,
  PRESENTATION_ALLOW_LIST,
} from "./allow-list.js";

/**
 * Where kippu-api runs. The ledger backend follows from it (`F-020` plan §5.4):
 * `backend-memory` in development and tests, `binding-offchain` elsewhere.
 */
export type LedgerEnvironment = "development" | "test" | "production";

export const LEDGER_ENVIRONMENTS: readonly LedgerEnvironment[] = [
  "development",
  "test",
  "production",
];

export interface MakeTickettoOptions {
  readonly environment: LedgerEnvironment;
  /** The deployment's holder credential RP id, a `profile-v0` parameter (`F-003` §5.3). */
  readonly holderRpId: string;
  /** `F-023`'s sponsor client (`REQ-SP-1`). */
  readonly sponsor: Sponsor;
  /** How long an assembled command stays valid, in milliseconds. `AD-15` sets no default. */
  readonly operationLifetime: number;
  readonly now?: () => Timestamp;
}

/** A command method, with its input held to the `NFR-6` allow-list. */
type Write<Kind extends CommandKind, Result> = <Input extends CommandInput<Kind>>(
  signer: Signer,
  input: Input & Allowed<Input, CommandInput<Kind>>,
) => Result;

type CommandMethods = {
  [Kind in CommandKind]: Ticketto[Kind] extends (...args: never[]) => infer Result
    ? Write<Kind, Result>
    : never;
};

/**
 * The SDK as kippu-api uses it: the surface of `C1`, with every command input
 * held to the `NFR-6` allow-list at compile time and again at runtime. The
 * signer is resolved per request by the caller (`F-021`).
 */
export type KippuTicketto = Omit<Ticketto, CommandKind | "submitAccessPass"> &
  CommandMethods & {
    submitAccessPass<Pass extends SignedAccessPass, Presentation extends PassPresentation>(
      pass: Pass & Allowed<Pass, SignedAccessPass>,
      presentation: Presentation & Allowed<Presentation, PassPresentation>,
    ): Submission<Receipt>;
  };

function backendFor(environment: LedgerEnvironment, profile: Profile): Backend {
  switch (environment) {
    case "development":
    case "test":
      return createMemoryBackend({ profile });
    case "production":
      // `binding-offchain` does not yet implement the backend port (`T-007-02`,
      // `T-007-03`). Its configuration will be the ledger service's endpoint —
      // never credentials for its store (`REQ-SDK-9`).
      throw new Error(
        "the production ledger backend (binding-offchain) is not available yet; " +
          "kippu-api cannot relay ledger writes in production",
      );
  }
}

/**
 * `makeTicketto` — the SDK factory per environment (`F-020` plan §5.4). The
 * only place kippu-api constructs the SDK, and the boundary personal data may
 * not cross (`NFR-6`).
 */
export function makeTicketto(options: MakeTickettoOptions): KippuTicketto {
  const profile = createProfileV0({ rpId: options.holderRpId });
  const sdk = createTicketto({
    backend: backendFor(options.environment, profile),
    profile,
    sponsor: options.sponsor,
    operationLifetime: options.operationLifetime,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const guard = <Kind extends CommandKind>(kind: Kind, input: unknown): void => {
    assertAllowed(input, COMMAND_INPUT_ALLOW_LIST[kind], kind);
  };

  const write = <Kind extends CommandKind>(kind: Kind) =>
    ((signer: Signer, input: CommandInput<Kind>) => {
      guard(kind, input);
      return (sdk[kind] as unknown as (signer: Signer, input: CommandInput<Kind>) => unknown)(
        signer,
        input,
      );
    }) as unknown as Write<Kind, ReturnType<Ticketto[Kind]>>;

  return {
    createEvent: write("createEvent") as Write<"createEvent", Derived<EventId>>,
    setEventStatus: write("setEventStatus"),
    setEventCapacity: write("setEventCapacity"),
    addZone: write("addZone"),
    removeZone: write("removeZone"),
    issueTicket: write("issueTicket") as Write<"issueTicket", Derived<TicketId>>,
    transferTicket: write("transferTicket"),
    removeRestriction: write("removeRestriction"),
    registerCredential: write("registerCredential"),
    submitAccessPass(pass, presentation) {
      assertAllowed(pass, PASS_ALLOW_LIST, "submitAccessPass.pass");
      assertAllowed(presentation, PRESENTATION_ALLOW_LIST, "submitAccessPass.presentation");
      return sdk.submitAccessPass(pass, presentation);
    },
    getEvent: (event) => sdk.getEvent(event),
    getTicket: (ticket) => sdk.getTicket(ticket),
    canAttend: (event, ticket) => sdk.canAttend(event, ticket),
    getCancellationHolder: (ticket) => sdk.getCancellationHolder(ticket),
    getCredential: (account, credential) => sdk.getCredential(account, credential),
    assurance: () => sdk.assurance(),
    get log() {
      return sdk.log;
    },
  };
}
