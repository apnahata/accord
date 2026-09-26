import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Merchant } from "../src/merchant.js";
import type { MerchantContract } from "../src/merchant.js";
import { TestStore } from "./support.js";

// Minimal test-only contracts exercise the generic storage layer, not an alternate domain implementation.
export const offer = z.object({ id: z.string(), version: z.number(), available: z.boolean(), expires: z.string() });
export const mutation = z.enum(["CHANGE", "FAIL", "SELL_OUT", "NO_VERSION", "EXPIRE"]);
export const event = z.object({ kind: z.string(), version: z.number() });
type O = z.infer<typeof offer>;
type M = z.infer<typeof mutation>;
type E = z.infer<typeof event>;
export const contract: MerchantContract<O, M, E> = {
  offer, mutation, event, id: value => value.id, version: value => String(value.version),
  available: value => value.available, expiresAt: value => value.expires,
  apply: (current, _original, command) => ({ offer: { ...current,
    version: current.version + (command === "NO_VERSION" ? 0 : 1),
    available: command !== "SELL_OUT", expires: command === "EXPIRE" ? "2000-01-01T00:00:00Z" : current.expires,
  }, failNextBooking: command === "FAIL" }),
  mutationEvent: (_before, after) => ({ kind: "mutated", version: after.version }),
  bookingEvent: current => ({ kind: "booked", version: current.version }),
};
async function setup() {
  const store = new TestStore<O, E>();
  const merchant = new Merchant(store, contract);
  await merchant.seed([{ id: "offer", version: 1, available: true, expires: "2099-01-01T00:00:00Z" }]);
  return { store, merchant };
}
const request = { offerId: "offer", expectedOfferVersion: "1", idempotencyKey: "purchase-1" };

test("mutation commits merchant state, advances version and enqueues real outbox event", async () => {
  const { store, merchant } = await setup();
  assert.equal((await merchant.mutate("offer", "CHANGE")).version, 2);
  assert.equal(store.offers.get("offer")?.offer.version, 2);
  assert.equal(store.events.size, 1);
  await assert.rejects(merchant.execute(request), /OFFER_VERSION_MISMATCH/);
  assert.equal(store.bookings.size, 0);
});
test("concurrent duplicate execution creates exactly one demo booking and one event", async () => {
  const { store, merchant } = await setup();
  const results = await Promise.all(Array.from({ length: 20 }, () => merchant.execute(request)));
  assert.equal(new Set(results.map(value => value.bookingReference)).size, 1);
  assert.equal(store.bookings.size, 1);
  assert.equal(store.events.size, 1);
  assert.equal(results[0]?.mode, "SIMULATED");
});
test("different idempotency keys cannot double-book one inventory item", async () => {
  const { store, merchant } = await setup();
  const results = await Promise.allSettled([merchant.execute(request), merchant.execute({ ...request, idempotencyKey: "other" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(store.bookings.size, 1);
});
test("idempotency key cannot be reused for a different quote", async () => {
  const { merchant } = await setup(); await merchant.execute(request);
  await assert.rejects(merchant.execute({ ...request, expectedOfferVersion: "2" }), /IDEMPOTENCY_CONFLICT/);
});
test("failed booking consumes failure flag without producing a receipt", async () => {
  const { merchant, store } = await setup();
  await merchant.mutate("offer", "FAIL");
  await assert.rejects(merchant.execute({ ...request, expectedOfferVersion: "2" }), /DEMO_BOOKING_FAILURE/);
  assert.equal(store.bookings.size, 0);
  assert.equal(store.offers.get("offer")?.failNextBooking, false);
});
for (const command of ["SELL_OUT", "EXPIRE"] as const) test(`${command} blocks merchant execution`, async () => {
  const { merchant, store } = await setup(); await merchant.mutate("offer", command);
  await assert.rejects(merchant.execute({ ...request, expectedOfferVersion: "2" }));
  assert.equal(store.bookings.size, 0);
});
test("invalid mutation rolls back state and outbox", async () => {
  const { merchant, store } = await setup();
  await assert.rejects(merchant.mutate("offer", "NO_VERSION"), /MUTATION_MUST_ADVANCE_VERSION/);
  assert.equal(store.offers.get("offer")?.offer.version, 1);
  assert.equal(store.events.size, 0);
});
