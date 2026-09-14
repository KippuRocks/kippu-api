import { softwareP256Signer } from "@ticketto/profile-v0/testing";
import type {
  CommandInput,
  EventId,
  Signer,
  Sponsor,
  Sponsorship,
  TicketId,
  ZoneId,
} from "@ticketto/sdk";
import { describe, expect, it } from "vitest";
import {
  COMMAND_INPUT_ALLOW_LIST,
  PersonalDataBoundaryError,
} from "../../src/ledger/allow-list.js";
import { type KippuTicketto, makeTicketto } from "../../src/ledger/ticketto.js";

const sponsor: Sponsor = {
  sponsor: async () => ({ ok: true, value: new Uint8Array() as Sponsorship }),
};

const options = { holderRpId: "holder.kippu.example", sponsor, operationLifetime: 60_000 };
const zoneId = "11".repeat(32) as ZoneId;

function counting(inner: Signer): Signer & { readonly count: () => number } {
  let signatures = 0;
  return {
    account: inner.account,
    count: () => signatures,
    sign: (payload) => {
      signatures += 1;
      return inner.sign(payload);
    },
  };
}

/**
 * Never called: each `@ts-expect-error` below must be an error, or type-checking
 * fails with an unused directive. This is the `NFR-6` check `T-020-08` delivers.
 */
function personalDataFailsTypeChecking(ticketto: KippuTicketto, signer: Signer): void {
  const event = "22".repeat(32) as EventId;

  // A literal with a personal-data field.
  // @ts-expect-error — `email` is not on the allow-list.
  ticketto.setEventStatus(signer, { event, status: "Sealed", email: "someone@example.test" });

  // The same field arriving in a variable, where excess-property checks do not apply.
  const withName = { event, status: "Sealed" as const, organiserName: "Ada Lovelace" };
  // @ts-expect-error — `organiserName` is not on the allow-list.
  ticketto.setEventStatus(signer, withName);

  // A personal-data field nested inside an allowed object.
  const zone = { id: zoneId, kind: "Seated" as const, venueContactPhone: "+57 300 000 0000" };
  // @ts-expect-error — `zone.venueContactPhone` is not on the allow-list.
  ticketto.addZone(signer, { event, zone });

  // Inside an array of allowed objects.
  const zones = [{ id: zoneId, kind: "Unseated" as const, notes: "call Ada on arrival" }];
  // @ts-expect-error — `zones[].notes` is not on the allow-list.
  ticketto.createEvent(signer, { salt: new Uint8Array(32), zones, capacity: null, metadata: null });

  // The allowed fields, from a variable, still type-check.
  const allowed: CommandInput<"setEventStatus"> = { event, status: "Sealed" };
  ticketto.setEventStatus(signer, allowed);
  const issue = {
    event,
    zone: zoneId,
    placement: { kind: "Unseated" as const, discriminator: "33".repeat(16) as never },
    class: "44".repeat(32) as never,
    provenance: "Granted" as const,
    policy: { kind: "Single" as const },
    restrictions: { cannotResale: true, cannotTransfer: false },
    holder: signer.account,
    metadata: null,
  };
  const derived: { id: TicketId } = ticketto.issueTicket(signer, issue);
  void derived;
}
void personalDataFailsTypeChecking;

describe("makeTicketto", () => {
  it("covers every command kind the SDK surface has in the allow-list", () => {
    expect(Object.keys(COMMAND_INPUT_ALLOW_LIST).sort()).toEqual([
      "addZone",
      "createEvent",
      "issueTicket",
      "registerCredential",
      "removeRestriction",
      "removeZone",
      "setEventCapacity",
      "setEventStatus",
      "transferTicket",
    ]);
  });

  it("runs against backend-memory in tests, whose ledger rules decide", async () => {
    const ticketto = makeTicketto({ ...options, environment: "test" });
    const unregistered = softwareP256Signer().signer;

    const created = ticketto.createEvent(unregistered, {
      salt: new Uint8Array(32).fill(7),
      zones: [{ id: zoneId, kind: "Unseated" }],
      capacity: 10,
      metadata: null,
    });

    // The rules behind the port refuse an account that never registered (REQ-CP-6).
    expect(await created.submission).toMatchObject({
      ok: false,
      error: { code: "ERR-InvalidAuthorisation" },
    });
    expect(await ticketto.getEvent(created.id)).toMatchObject({
      ok: false,
      error: { code: "ERR-EventNotFound" },
    });
  });

  it("uses backend-memory in development too", () => {
    expect(() => makeTicketto({ ...options, environment: "development" })).not.toThrow();
  });

  it("refuses production until binding-offchain implements the backend port", () => {
    expect(() => makeTicketto({ ...options, environment: "production" })).toThrow(
      /binding-offchain/,
    );
  });

  describe("NFR-6 at runtime, for what the compiler cannot see", () => {
    const ticketto = makeTicketto({ ...options, environment: "test" });
    const event = "22".repeat(32) as EventId;

    it.each([
      ["a top-level field", { event, status: "Sealed", email: "a@b.test" }, "setEventStatus.email"],
      [
        "a nested field",
        { event, zone: { id: zoneId, kind: "Seated", phone: "+57" } },
        "addZone.zone.phone",
      ],
      [
        "an object where a value belongs",
        { event, status: { name: "Ada" } },
        "setEventStatus.status",
      ],
    ])("NFR-6: refuses %s before anything is signed", (_, input, field) => {
      const signer = counting(softwareP256Signer().signer);
      const call = () =>
        field.startsWith("addZone")
          ? ticketto.addZone(signer, input as never)
          : ticketto.setEventStatus(signer, input as never);

      expect(call).toThrow(PersonalDataBoundaryError);
      try {
        call();
      } catch (error) {
        expect((error as PersonalDataBoundaryError).field).toBe(field);
      }
      expect(signer.count()).toBe(0);
    });

    it("NFR-6: refuses a field inside an array of allowed objects", () => {
      const signer = counting(softwareP256Signer().signer);
      expect(() =>
        ticketto.createEvent(signer, {
          salt: new Uint8Array(32),
          zones: [{ id: zoneId, kind: "Unseated", note: "Ada" }],
          capacity: null,
          metadata: null,
        } as never),
      ).toThrow(/createEvent\.zones\[0\]\.note/);
      expect(signer.count()).toBe(0);
    });
  });
});
