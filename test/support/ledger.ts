import {
  type AssuranceDeclaration,
  type Backend,
  type Command,
  type Cursor,
  createSubmission,
  type LogReader,
  type OperationId,
  type Receipt,
  type Sponsor,
  type Sponsorship,
  type Submission,
  type TickettoErrorCode,
} from "@ticketto/sdk";
import { expect } from "vitest";
import type { AuditLog } from "../../src/audit/audit-log.js";

/**
 * A scripted backend for relay tests. It enforces nothing: it settles every
 * command with the next cursor unless told to reject or fail a command kind,
 * and remembers every write it was handed. Replaced by `backend-memory` once
 * the SDK factory exists (`T-020-08`).
 */
export interface ScriptedBackend extends Backend {
  /** The operation id of every command submitted, in order. */
  readonly submitted: OperationId[];
  reject(kind: Command["kind"], code: TickettoErrorCode): void;
  fail(kind: Command["kind"], reason: Error): void;
}

export function scriptedBackend(): ScriptedBackend {
  const submitted: OperationId[] = [];
  const rejections = new Map<Command["kind"], TickettoErrorCode>();
  const failures = new Map<Command["kind"], Error>();
  let position = 0;

  return {
    submitted,
    reject: (kind, code) => rejections.set(kind, code),
    fail: (kind, reason) => failures.set(kind, reason),
    submit(input): Submission<Receipt> {
      const controller = createSubmission();
      if (input.kind !== "command") {
        throw new Error("the scripted backend takes commands only");
      }
      const { command } = input.signed;
      submitted.push(command.operationId);
      queueMicrotask(() => {
        controller.submitted(command.operationId);
        const failure = failures.get(command.kind);
        const rejection = rejections.get(command.kind);
        if (failure !== undefined) {
          controller.failed(failure);
        } else if (rejection !== undefined) {
          controller.rejected({ code: rejection });
        } else {
          position += 1;
          controller.settled({
            operationId: command.operationId,
            cursor: `c${position}` as Cursor,
          });
        }
      });
      return controller.submission;
    },
    query: () => Promise.reject(new Error("the scripted backend answers no queries")),
    log: {} as LogReader,
    assurance: {} as AssuranceDeclaration,
  };
}

/** A sponsor that sponsors everything, or refuses everything. */
export function scriptedSponsor(refuse = false): Sponsor & { readonly seen: OperationId[] } {
  const seen: OperationId[] = [];
  return {
    seen,
    async sponsor(input) {
      if ("command" in input) {
        seen.push(input.command.operationId);
      }
      return refuse
        ? { ok: false, error: { code: "ERR-SponsorshipRefused" } }
        : { ok: true, value: new Uint8Array() as Sponsorship };
    },
  };
}

/**
 * `NFR-7`: every relayed write has an audit row. Integration tests of features
 * that relay writes call this with the operation ids their backend received.
 */
export async function expectEveryRelayedWriteAudited(
  audit: AuditLog,
  operationIds: readonly OperationId[],
): Promise<void> {
  expect(operationIds.length).toBeGreaterThan(0);
  for (const operationId of operationIds) {
    expect(await audit.find(operationId), `audit row for ${operationId}`).not.toBeNull();
  }
}
