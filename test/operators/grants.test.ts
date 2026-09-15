import { randomBytes } from "node:crypto";
import { LOG_START } from "@ticketto/sdk";
import { TRPCClientError } from "@trpc/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { GrantInput } from "../../src/operators/ports.js";
import type { AppRouter } from "../../src/trpc/router.js";
import { describeWithStore } from "../support/database.js";
import {
  type Client,
  type OperatorHarness,
  operatorHarness,
  refused,
} from "../support/operator-harness.js";

const HOUR = 60 * 60 * 1000;

describeWithStore("operator grants", () => {
  let harness: OperatorHarness;

  beforeAll(async () => {
    harness = await operatorHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  interface Setup {
    readonly organiserId: string;
    readonly client: Client;
    readonly event: string;
    readonly operator: string;
  }

  async function setup(): Promise<Setup> {
    const organiser = await harness.organiser();
    const event = await harness.createEvent(organiser.organiserId);
    const { id } = await organiser.client.operators.create.mutate({ name: "Gate staff" });
    return { ...organiser, event, operator: id };
  }

  const window = (fromOffset = 0, length = 4 * HOUR) => {
    const from = harness.now().getTime() + fromOffset;
    return { from, until: from + length };
  };

  const grantOf = (
    { event, operator }: Setup,
    overrides: Partial<GrantInput> = {},
  ): GrantInput => ({ operator, event, gates: ["North door"], ...window(), ...overrides });

  /** Signs the operator in with a code their organiser issues. */
  async function operatorClient({ client, operator }: Setup): Promise<Client> {
    const { code } = await client.operators.issueEnrolmentCode.mutate({ operator });
    const { session } = await harness.client().auth.operator.redeemEnrolmentCode.mutate({ code });
    return harness.client(session.token);
  }

  async function ledgerState() {
    const page = await harness.ledger.log.read(LOG_START, 10_000);
    if (!page.ok) throw new Error(page.error.code);
    const audited = await harness.database.store.query("SELECT count(*)::int AS n FROM audit_log");
    return {
      records: page.value.records.length,
      next: page.value.next,
      sponsored: harness.sponsoredWrites(),
      audited: audited.rows[0].n as number,
    };
  }

  async function errorCode(call: () => Promise<unknown>): Promise<string | null | undefined> {
    try {
      await call();
    } catch (error) {
      if (error instanceof TRPCClientError) {
        return (error as TRPCClientError<AppRouter>).data?.errorCode;
      }
      throw error;
    }
    throw new Error("expected the call to be refused");
  }

  it("AC-E5.1: grant and revoke change no ledger state", async () => {
    const context = await setup();
    const signedIn = await operatorClient(context);
    const before = await ledgerState();

    const grant = await context.client.operators.grants.create.mutate(
      grantOf(context, { gates: ["North door", "South door"] }),
    );
    expect(grant).toMatchObject({
      operator: context.operator,
      event: context.event,
      gates: ["North door", "South door"],
      revokedAt: null,
    });
    expect(await signedIn.operators.grants.mine.query()).toEqual([grant]);

    const revoked = await context.client.operators.grants.revoke.mutate({ grant: grant.id });
    expect(revoked).toEqual({ ...grant, revokedAt: harness.now().toISOString() });
    expect(await signedIn.operators.grants.mine.query()).toEqual([]);
    expect(
      await context.client.operators.grants.list.query({ event: null, operator: null }),
    ).toEqual([revoked]);

    expect(await ledgerState()).toEqual(before);
  });

  it("a grant needs an event the organiser owns on the ledger", async () => {
    const context = await setup();
    const other = await setup();

    expect(
      await errorCode(() =>
        context.client.operators.grants.create.mutate(grantOf(context, { event: other.event })),
      ),
    ).toBe("ERR-NotOwner");
    expect(
      await errorCode(() =>
        context.client.operators.grants.create.mutate(
          grantOf(context, { event: randomBytes(32).toString("hex") }),
        ),
      ),
    ).toBe("ERR-EventNotFound");
    expect(
      await context.client.operators.grants.list.query({ event: null, operator: null }),
    ).toEqual([]);
  });

  it("an organiser grants and revokes only for their own operators and grants", async () => {
    const context = await setup();
    const other = await setup();

    expect(
      await refused(() =>
        context.client.operators.grants.create.mutate(
          grantOf(context, { operator: other.operator }),
        ),
      ),
    ).toEqual({ code: "NOT_FOUND", reason: "unknown-operator" });

    const grant = await other.client.operators.grants.create.mutate(grantOf(other));
    expect(
      await refused(() => context.client.operators.grants.revoke.mutate({ grant: grant.id })),
    ).toEqual({ code: "NOT_FOUND", reason: "unknown-grant" });
    expect(
      await context.client.operators.grants.list.query({ event: null, operator: null }),
    ).toEqual([]);
    expect(await other.client.operators.grants.list.query({ event: null, operator: null })).toEqual(
      [grant],
    );
  });

  it("a grant names distinct gates, and a window that ends after it starts", async () => {
    const context = await setup();
    const { from } = window();

    for (const overrides of [
      { gates: [] },
      { gates: ["North door", "North door"] },
      { gates: [" "] },
      { from, until: from },
      { from, until: from - 1 },
    ] satisfies Partial<GrantInput>[]) {
      expect(
        await refused(() =>
          context.client.operators.grants.create.mutate(grantOf(context, overrides)),
        ),
      ).toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("revoking a revoked grant changes nothing", async () => {
    const context = await setup();
    const grant = await context.client.operators.grants.create.mutate(grantOf(context));
    const revoked = await context.client.operators.grants.revoke.mutate({ grant: grant.id });

    harness.advance(HOUR);
    expect(await context.client.operators.grants.revoke.mutate({ grant: grant.id })).toEqual(
      revoked,
    );
  });

  it("an organiser lists their grants by event and by operator", async () => {
    const context = await setup();
    const secondEvent = await harness.createEvent(context.organiserId);
    const { id: secondOperator } = await context.client.operators.create.mutate({ name: "Bar" });

    const a = await context.client.operators.grants.create.mutate(grantOf(context));
    const b = await context.client.operators.grants.create.mutate(
      grantOf(context, { event: secondEvent }),
    );
    const c = await context.client.operators.grants.create.mutate(
      grantOf(context, { operator: secondOperator }),
    );
    const list = (input: { event: string | null; operator: string | null }) =>
      context.client.operators.grants.list.query(input);

    expect(await list({ event: null, operator: null })).toEqual([a, b, c]);
    expect(await list({ event: context.event, operator: null })).toEqual([a, c]);
    expect(await list({ event: null, operator: secondOperator })).toEqual([c]);
    expect(await list({ event: secondEvent, operator: context.operator })).toEqual([b]);
  });

  it("an operator's own grants are the live and upcoming ones, soonest first", async () => {
    const context = await setup();
    const signedIn = await operatorClient(context);
    const { id: colleague } = await context.client.operators.create.mutate({ name: "Colleague" });
    const create = (overrides: Partial<GrantInput>) =>
      context.client.operators.grants.create.mutate(grantOf(context, overrides));

    const later = await create(window(2 * HOUR));
    const now = await create(window(-HOUR));
    await create(window(-3 * HOUR, HOUR)); // ended
    const revoked = await create(window());
    await context.client.operators.grants.revoke.mutate({ grant: revoked.id });
    await create({ operator: colleague });

    expect(await signedIn.operators.grants.mine.query()).toEqual([now, later]);
    expect(await refused(() => context.client.operators.grants.mine.query())).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      await refused(() => signedIn.operators.grants.create.mutate(grantOf(context))),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});
