import { randomBytes } from "node:crypto";
import type { CommandKind, TicketId } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { COMMAND_INPUT_ALLOW_LIST } from "../../src/ledger/allow-list.js";
import { appRouter } from "../../src/trpc/router.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

describeWithStore("restriction removal", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function pressTicket(
    restrictions = { cannotResale: true, cannotTransfer: true },
  ): Promise<{ organiser: TestOrganiser; event: string; ticket: string }> {
    const organiser = await harness.organiser();
    const zone = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: zone, kind: "Unseated" }],
      capacity: null,
    });
    const press = await organiser.client.events.classes.define.mutate({
      event,
      name: "Press",
      description: null,
      provenance: "Granted",
      policy: { kind: "Single" },
      restrictions,
      quota: null,
    });
    const { ticket } = await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: press.id,
      zone,
      placement: { kind: "Unseated" },
      holder: randomBytes(32).toString("hex"),
    });
    return { organiser, event, ticket };
  }

  const restrictionsOf = async (ticket: string) => {
    const found = await harness.ledger.getTicket(ticket as TicketId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value.restrictions;
  };

  it("AC-B3.4: removing a restriction succeeds, one flag at a time", async () => {
    const { organiser, event, ticket } = await pressTicket();

    const transferable = await organiser.client.events.tickets.removeRestriction.mutate({
      event,
      ticket,
      restriction: "cannotTransfer",
    });
    expect(transferable).toEqual({
      event,
      ticket,
      restrictions: { cannotResale: true, cannotTransfer: false },
      cursor: expect.any(String),
    });
    expect(await restrictionsOf(ticket)).toEqual({ cannotResale: true, cannotTransfer: false });

    const free = await organiser.client.events.tickets.removeRestriction.mutate({
      event,
      ticket,
      restriction: "cannotResale",
    });
    expect(free.restrictions).toEqual({ cannotResale: false, cannotTransfer: false });

    // Removing a restriction the ticket no longer has changes nothing.
    await organiser.client.events.tickets.removeRestriction.mutate({
      event,
      ticket,
      restriction: "cannotResale",
    });
    expect(await restrictionsOf(ticket)).toEqual({ cannotResale: false, cannotTransfer: false });
  });

  it("REQ-TK-2: freeing a ticket that cannot be transferred for resale frees it for transfer too", async () => {
    const { organiser, event, ticket } = await pressTicket();

    const freed = await organiser.client.events.tickets.removeRestriction.mutate({
      event,
      ticket,
      restriction: "cannotResale",
    });

    expect(freed.restrictions).toEqual({ cannotResale: false, cannotTransfer: false });
  });

  it("AC-B3.4: adding a restriction after issuance fails — Kippu and the ledger have no way to", async () => {
    const { organiser, event, ticket } = await pressTicket({
      cannotResale: false,
      cannotTransfer: false,
    });

    // The one restriction write Kippu exposes only removes; a request to add is malformed.
    for (const input of [
      { event, ticket, restriction: "addCannotResale" },
      { event, ticket, restriction: "cannotResale", restrictions: { cannotResale: true } },
    ]) {
      expect(
        await refusal(() =>
          organiser.client.events.tickets.removeRestriction.mutate(input as never),
        ),
      ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    }
    expect(await restrictionsOf(ticket)).toEqual({ cannotResale: false, cannotTransfer: false });

    // No procedure, and no ledger command, restricts an issued ticket (INV-10).
    const procedures = Object.keys(appRouter._def.procedures).filter((path) =>
      /restrict/i.test(path),
    );
    expect(procedures).toEqual(["events.tickets.removeRestriction"]);
    const commands = Object.keys(COMMAND_INPUT_ALLOW_LIST) as CommandKind[];
    expect(commands.filter((kind) => /restrict/i.test(kind))).toEqual(["removeRestriction"]);
  });

  it("ERR-NotOwner and ERR-TicketNotFound: only the event's organiser frees its tickets", async () => {
    const { organiser, event, ticket } = await pressTicket();
    const other = await harness.organiser();

    expect(
      await refusal(() =>
        other.client.events.tickets.removeRestriction.mutate({
          event,
          ticket,
          restriction: "cannotTransfer",
        }),
      ),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
    expect(
      await refusal(() =>
        organiser.client.events.tickets.removeRestriction.mutate({
          event,
          ticket: randomId(),
          restriction: "cannotTransfer",
        }),
      ),
    ).toEqual({ code: "NOT_FOUND", errorCode: "ERR-TicketNotFound" });
    expect(await restrictionsOf(ticket)).toEqual({ cannotResale: true, cannotTransfer: true });
  });
});
