import { COMMAND_SIGNING_TAG, decodeCommand } from "@ticketto/profile-v0";
import {
  type Command,
  createSubmission,
  type Derived,
  type OperationId,
  type Receipt,
  type Signer,
  type Submission,
} from "@ticketto/sdk";
import { AuditError, type AuditLog, type RelayRequest } from "./audit-log.js";

/**
 * The command a V0 command signing payload authorises, or `null` when the
 * bytes are not one. A signing payload is the command tag followed by the
 * command's canonical encoding (`F-003` plan §5.7).
 */
export function commandOfSigningPayload(payload: Uint8Array): Command | null {
  const tag = COMMAND_SIGNING_TAG;
  if (payload.length <= tag.length || tag.some((byte, index) => payload[index] !== byte)) {
    return null;
  }
  try {
    return decodeCommand(payload.subarray(tag.length));
  } catch {
    return null;
  }
}

/**
 * A signer that records the audit row for a command before it signs it
 * (`NFR-7`). It refuses to sign anything it cannot attribute: bytes that are
 * not a command, or a command whose row cannot be written. So a signature over
 * a relayed write exists only with a prior audit row.
 */
export function auditedSigner(
  signer: Signer,
  audit: AuditLog,
  request: RelayRequest,
  onRecorded: (operationId: OperationId) => void = () => {},
): Signer {
  return {
    account: signer.account,
    async sign(payload) {
      const command = commandOfSigningPayload(payload);
      if (command === null) {
        throw new AuditError("refusing to sign a payload that is not a command");
      }
      await audit.record({
        ...request,
        operationId: command.operationId,
        commandKind: command.kind,
      });
      onRecorded(command.operationId);
      return signer.sign(payload);
    },
  };
}

export interface RelayOptions {
  readonly audit: AuditLog;
  readonly request: RelayRequest;
  /**
   * Called when a write's outcome could not be added to its row. The write's
   * attribution is already recorded; only its outcome is missing, and the
   * ledger's log still has it. Defaults to `console.error`.
   */
  readonly onAuditFailure?: (error: unknown) => void;
}

type Write = Submission<Receipt> | Derived<unknown>;

function isDerived(write: Write): write is Derived<unknown> {
  return "submission" in write;
}

/**
 * Relays one ledger write on behalf of a request: every write Kippu relays
 * goes through here (`NFR-7`, `F-020` plan §5.3).
 *
 * `write` receives an audited signer and performs the SDK call with it. The
 * audit row is written before the signature; the submission returned settles
 * or is rejected only after the row records how the write ended, with the
 * receipt's cursor when it settled.
 */
export function relay<W extends Write>(
  { audit, request, onAuditFailure = (error) => console.error(error) }: RelayOptions,
  signer: Signer,
  write: (signer: Signer) => W,
): W {
  let recorded: OperationId | null = null;
  const result = write(
    auditedSigner(signer, audit, request, (operationId) => {
      recorded = operationId;
    }),
  );
  const source: Submission<Receipt> = isDerived(result)
    ? result.submission
    : (result as Submission<Receipt>);
  const target = createSubmission();

  const complete = async (outcome: Parameters<AuditLog["complete"]>[1]): Promise<void> => {
    if (recorded === null) {
      return;
    }
    try {
      await audit.complete(recorded, outcome);
    } catch (error) {
      onAuditFailure(error);
    }
  };

  (async () => {
    let submitted = false;
    try {
      for await (const state of source) {
        switch (state.state) {
          case "submitted":
            if (!submitted) target.submitted(state.operationId);
            submitted = true;
            break;
          case "settled":
            await complete({ outcome: "settled", cursor: state.receipt.cursor });
            target.settled(state.receipt);
            return;
          case "rejected":
            await complete({ outcome: "rejected", errorCode: state.error.code });
            target.rejected(state.error);
            return;
        }
      }
      const outcome = await source;
      if (outcome.ok) {
        await complete({ outcome: "settled", cursor: outcome.value.cursor });
        target.settled(outcome.value);
      } else {
        await complete({ outcome: "rejected", errorCode: outcome.error.code });
        target.rejected(outcome.error);
      }
    } catch (reason) {
      await complete({ outcome: "failed" });
      target.failed(reason);
    }
  })();

  return (
    isDerived(result) ? { ...result, submission: target.submission } : target.submission
  ) as W;
}
