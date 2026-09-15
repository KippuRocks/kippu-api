import { randomBytes } from "node:crypto";
import { encodeSignedAccessPass, encodeSignedCommand } from "@ticketto/profile-v0";
import type { Cursor } from "@ticketto/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DefineClassInput, SaleAsset } from "../../src/events/ports.js";
import { describeWithStore } from "../support/database.js";
import {
  type EventsHarness,
  eventsHarness,
  randomId,
  refusal,
  type TestOrganiser,
} from "../support/events.js";

const stalls = (event: string, overrides: Partial<DefineClassInput> = {}): DefineClassInput => ({
  event,
  name: "Stalls",
  description: null,
  provenance: "Purchased",
  policy: { kind: "Single" },
  restrictions: { cannotResale: false, cannotTransfer: false },
  quota: null,
  price: 25_000,
  ...overrides,
});

/** Little-endian bytes of `value`, `length` long. */
function littleEndian(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let rest = value;
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

/** SCALE's compact encoding of `value`, as a price would be encoded if it were carried. */
function compact(value: bigint): Uint8Array {
  if (value < 1n << 6n) return Uint8Array.of(Number(value << 2n));
  if (value < 1n << 14n) return littleEndian((value << 2n) | 1n, 2);
  if (value < 1n << 30n) return littleEndian((value << 2n) | 2n, 4);
  let length = 4;
  while (value >= 1n << BigInt(8 * length)) length += 1;
  return Uint8Array.of(((length - 4) << 2) | 3, ...littleEndian(value, length));
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

describeWithStore("sale assets and prices", () => {
  let harness: EventsHarness;

  beforeAll(async () => {
    harness = await eventsHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  interface Setup {
    readonly organiser: TestOrganiser;
    readonly event: string;
    readonly unseated: string;
  }

  async function setup(saleAsset?: SaleAsset | null): Promise<Setup> {
    const organiser = await harness.organiser();
    const unseated = randomId();
    const { event } = await organiser.client.events.create.mutate({
      zones: [{ id: unseated, kind: "Unseated" }],
      capacity: null,
      ...(saleAsset === undefined ? {} : { saleAsset }),
    });
    return { organiser, event, unseated };
  }

  /** A linked buyer's checkout of the class, and the outcome of holding it. */
  async function hold(context: Setup, classId: string) {
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event: context.event,
      class: classId,
      zone: context.unseated,
      placement: { kind: "Unseated" },
    });
    return () => harness.anonymous().sales.checkout.hold.mutate({ token });
  }

  it("a Purchased class without a positive price is refused, and a Granted class has none", async () => {
    const { organiser, event } = await setup("COPM/2");
    const refused = { code: "BAD_REQUEST", errorCode: null };

    for (const price of [undefined, null, 0, -1, 2.5, Number.MAX_SAFE_INTEGER + 2]) {
      const input = { ...stalls(event), price } as DefineClassInput;
      if (price === undefined) delete (input as { price?: unknown }).price;
      expect(await refusal(() => organiser.client.events.classes.define.mutate(input))).toEqual(
        refused,
      );
    }
    expect(
      await refusal(() =>
        organiser.client.events.classes.define.mutate(
          stalls(event, { provenance: "Granted", name: "Guests", price: 100 }),
        ),
      ),
    ).toEqual(refused);
    expect(await organiser.client.events.classes.list.query({ event })).toEqual([]);

    const defined = await organiser.client.events.classes.define.mutate(stalls(event));
    const guests = await organiser.client.events.classes.define.mutate(
      stalls(event, { provenance: "Granted", name: "Guests", price: null }),
    );
    expect(defined.price).toBe(25_000);
    expect(guests.price).toBeNull();
  });

  it("the sale asset is chosen at creation or later, and cannot change after a hold", async () => {
    const context = await setup();
    const { organiser, event } = context;
    const stallsClass = await organiser.client.events.classes.define.mutate(stalls(event));

    expect(await organiser.client.events.saleAsset.query({ event })).toEqual({
      event,
      asset: null,
      fixed: false,
      unpriced: [],
    });
    // With no asset chosen nothing is offered, and nothing can be held.
    expect(await harness.anonymous().sales.inventory.query({ event })).toMatchObject({
      onSale: false,
      asset: null,
      classes: [],
    });
    const early = await hold(context, stallsClass.id);
    expect(await refusal(early)).toEqual({ code: "PRECONDITION_FAILED", errorCode: null });

    // Chosen later, and changed freely while nothing is held.
    await organiser.client.events.setSaleAsset.mutate({ event, asset: "COPM/2" });
    expect(
      await organiser.client.events.setSaleAsset.mutate({ event, asset: "DUSD/6" }),
    ).toMatchObject({
      event,
      asset: "DUSD/6",
      fixed: false,
    });
    // The change cleared the class's price (prices are in the asset's minor units): re-price it.
    await organiser.client.events.classes.setPrice.mutate({
      event,
      class: stallsClass.id,
      price: 5_000_000,
    });

    const placed = await hold(context, stallsClass.id);
    expect(await placed()).toMatchObject({ outcome: "held" });

    expect(
      await refusal(() => organiser.client.events.setSaleAsset.mutate({ event, asset: "COPM/2" })),
    ).toEqual({ code: "CONFLICT", errorCode: null });
    expect(await organiser.client.events.setSaleAsset.mutate({ event, asset: "DUSD/6" })).toEqual({
      event,
      asset: "DUSD/6",
      fixed: true,
      unpriced: [],
    });

    // Released, the hold still happened: the asset stays fixed.
    await harness.database.store.query(
      "UPDATE holds SET status = 'released', ended_at = now() WHERE event = $1",
      [event],
    );
    expect(
      await refusal(() => organiser.client.events.setSaleAsset.mutate({ event, asset: "COPM/2" })),
    ).toEqual({ code: "CONFLICT", errorCode: null });

    // An asset chosen at creation is recorded with the event.
    const atCreation = await setup("COPM/2");
    expect(
      await atCreation.organiser.client.events.saleAsset.query({ event: atCreation.event }),
    ).toMatchObject({ asset: "COPM/2", fixed: false });

    const other = await harness.organiser();
    expect(
      await refusal(() => other.client.events.setSaleAsset.mutate({ event, asset: "COPM/2" })),
    ).toEqual({ code: "FORBIDDEN", errorCode: "ERR-NotOwner" });
  });

  it("changing the sale asset clears every Purchased class's price, and the event is off sale until each is re-priced", async () => {
    const context = await setup("COPM/2");
    const { organiser, event } = context;
    const stallsClass = await organiser.client.events.classes.define.mutate(stalls(event));
    const balcony = await organiser.client.events.classes.define.mutate(
      stalls(event, { name: "Balcony", price: 12_000 }),
    );
    const guests = await organiser.client.events.classes.define.mutate(
      stalls(event, { provenance: "Granted", name: "Guests", price: null }),
    );
    expect(await harness.anonymous().sales.inventory.query({ event })).toMatchObject({
      onSale: true,
    });

    // 25 000 COPM/2 minor units is not 25 000 DUSD/6 minor units: the prices are cleared.
    expect(await organiser.client.events.setSaleAsset.mutate({ event, asset: "DUSD/6" })).toEqual({
      event,
      asset: "DUSD/6",
      fixed: false,
      unpriced: [stallsClass.id, balcony.id],
    });
    expect(
      (await organiser.client.events.classes.list.query({ event })).map(({ id, price }) => [
        id,
        price,
      ]),
    ).toEqual([
      [stallsClass.id, null],
      [balcony.id, null],
      [guests.id, null],
    ]);
    expect(await harness.anonymous().sales.inventory.query({ event })).toMatchObject({
      onSale: false,
      asset: "DUSD/6",
      classes: [],
    });
    expect(await refusal(await hold(context, stallsClass.id))).toEqual({
      code: "PRECONDITION_FAILED",
      errorCode: null,
    });

    // One class re-priced is not enough: every Purchased class must be.
    await organiser.client.events.classes.setPrice.mutate({
      event,
      class: stallsClass.id,
      price: 6_000_000,
    });
    expect(await organiser.client.events.saleAsset.query({ event })).toMatchObject({
      unpriced: [balcony.id],
    });
    expect(await harness.anonymous().sales.inventory.query({ event })).toMatchObject({
      onSale: false,
    });
    expect(await refusal(await hold(context, stallsClass.id))).toEqual({
      code: "PRECONDITION_FAILED",
      errorCode: null,
    });

    await organiser.client.events.classes.setPrice.mutate({
      event,
      class: balcony.id,
      price: 3_000_000,
    });
    expect(await harness.anonymous().sales.inventory.query({ event })).toMatchObject({
      onSale: true,
      asset: "DUSD/6",
      classes: [
        { id: stallsClass.id, price: 6_000_000 },
        { id: balcony.id, price: 3_000_000 },
      ],
    });
    expect(await (await hold(context, stallsClass.id))()).toMatchObject({ outcome: "held" });
  });

  it("setting the asset already in force, or choosing the first one, clears no price", async () => {
    const first = await setup();
    const priced = await first.organiser.client.events.classes.define.mutate(stalls(first.event));
    expect(
      await first.organiser.client.events.setSaleAsset.mutate({
        event: first.event,
        asset: "COPM/2",
      }),
    ).toMatchObject({ asset: "COPM/2", unpriced: [] });
    expect(
      await first.organiser.client.events.setSaleAsset.mutate({
        event: first.event,
        asset: "COPM/2",
      }),
    ).toMatchObject({ asset: "COPM/2", unpriced: [] });
    expect(await first.organiser.client.events.classes.list.query({ event: first.event })).toEqual([
      expect.objectContaining({ id: priced.id, price: 25_000 }),
    ]);
  });

  it("changing a price affects only holds placed afterwards", async () => {
    const context = await setup("COPM/2");
    const { organiser, event } = context;
    const stallsClass = await organiser.client.events.classes.define.mutate(stalls(event));

    expect(await (await hold(context, stallsClass.id))()).toMatchObject({ outcome: "held" });
    const repriced = await organiser.client.events.classes.setPrice.mutate({
      event,
      class: stallsClass.id,
      price: 30_000,
    });
    expect(repriced.price).toBe(30_000);
    expect(await (await hold(context, stallsClass.id))()).toMatchObject({ outcome: "held" });

    const held = await harness.database.store.query<{ asset: string; price: string }>(
      "SELECT asset, price FROM holds WHERE event = $1 ORDER BY created_at",
      [event],
    );
    expect(held.rows).toEqual([
      { asset: "COPM/2", price: "25000" },
      { asset: "COPM/2", price: "30000" },
    ]);
    expect(await harness.anonymous().sales.inventory.query({ event })).toMatchObject({
      onSale: true,
      asset: "COPM/2",
      classes: [{ id: stallsClass.id, price: 30_000 }],
    });

    const guests = await organiser.client.events.classes.define.mutate(
      stalls(event, { provenance: "Granted", name: "Guests", price: null }),
    );
    expect(
      await refusal(() =>
        organiser.client.events.classes.setPrice.mutate({ event, class: guests.id, price: 1 }),
      ),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });
    expect(
      await refusal(() =>
        organiser.client.events.classes.setPrice.mutate({ event, class: randomId(), price: 1 }),
      ),
    ).toEqual({ code: "UNPROCESSABLE_CONTENT", errorCode: "ERR-UnknownClass" });
    expect(
      await refusal(() =>
        organiser.client.events.classes.setPrice.mutate({ event, class: stallsClass.id, price: 0 }),
      ),
    ).toEqual({ code: "BAD_REQUEST", errorCode: null });
  });

  it("AC-B4.2: no price or sale asset reaches the ledger — granted or purchased issuance alike", async () => {
    const price = 7_391_842_615;
    const context = await setup("DUSD/6");
    const { organiser, event } = context;
    const stallsClass = await organiser.client.events.classes.define.mutate(
      stalls(event, { price }),
    );
    await organiser.client.events.classes.setPrice.mutate({
      event,
      class: stallsClass.id,
      price: price + 1,
    });
    expect(await (await hold(context, stallsClass.id))()).toMatchObject({ outcome: "held" });

    // A purchased ticket, paid for and issued through checkout (T-022-04).
    const buyer = await harness.linkedHolder();
    const { token } = await buyer.client.sales.checkout.begin.mutate({
      event,
      class: stallsClass.id,
      zone: context.unseated,
      placement: { kind: "Unseated" },
    });
    expect(await harness.anonymous().sales.checkout.hold.mutate({ token })).toMatchObject({
      outcome: "held",
    });
    const payment = await harness.anonymous().sales.checkout.pay.mutate({
      token,
      successUrl: "https://ichiba.kippu.example/paid",
      cancelUrl: "https://ichiba.kippu.example/cancelled",
    });
    expect(payment).toMatchObject({ amount: price + 1, asset: "DUSD/6" });
    const providerCheckout = payment.url.split("/").at(-1) as string;
    harness.payments.pay(providerCheckout);
    await harness.sales.payments.reconcile("webhook", providerCheckout);
    expect((await harness.anonymous().sales.checkout.get.query({ token })).sale?.status).toBe(
      "issued",
    );

    const guests = await organiser.client.events.classes.define.mutate(
      stalls(event, { provenance: "Granted", name: "Guests", price: null }),
    );
    await organiser.client.events.tickets.issueGranted.mutate({
      event,
      class: guests.id,
      zone: context.unseated,
      placement: { kind: "Unseated" },
      holder: randomBytes(32).toString("hex"),
    });

    // Every record of the ledger's log, as the signed bytes it was submitted as.
    const encoded: Uint8Array[] = [];
    let cursor = "" as Cursor;
    for (;;) {
      const page = await harness.ledger.log.read(cursor, 100);
      if (!page.ok) throw new Error(page.error.code);
      for (const record of page.value.records) {
        encoded.push(
          "command" in record.entry
            ? encodeSignedCommand(record.entry)
            : encodeSignedAccessPass(record.entry),
        );
      }
      if (page.value.records.length === 0 || page.value.next === cursor) break;
      cursor = page.value.next;
    }
    expect(encoded.length).toBeGreaterThan(0);

    const ascii = (text: string) => new TextEncoder().encode(text);
    const needles: [string, Uint8Array][] = [];
    for (const value of [price, price + 1]) {
      const big = BigInt(value);
      needles.push(
        [`${value} as u64`, littleEndian(big, 8)],
        [`${value} as u128`, littleEndian(big, 16)],
        [`${value} compact`, compact(big)],
        [`${value} in decimal`, ascii(String(value))],
      );
    }
    needles.push(["COPM", ascii("COPM")], ["DUSD", ascii("DUSD")]);
    for (const bytes of encoded) {
      for (const [name, needle] of needles) {
        expect(contains(bytes, needle), `${name} in a ledger record`).toBe(false);
      }
    }
  });
});
