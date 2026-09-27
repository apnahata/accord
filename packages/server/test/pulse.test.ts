import test from "node:test";
import assert from "node:assert/strict";
import { Pulse, type PriceObservation } from "../src/pulse.js";
import { LiteApi } from "../src/stays.js";

const trip = { destination: "Miami, FL", countryCode: "US", checkIn: "2027-03-10", checkOut: "2027-03-14", guests: 4, timeZone: "America/New_York" };

function fakePool() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return { queries, pool: { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [] }; } } as any };
}

test("price observations are batched, one cheapest row per listing, public fields only", async () => {
  const { pool, queries } = fakePool();
  const pulse = new Pulse(pool, 60_000);
  const row = (offerId: string, totalCents: number): PriceObservation => ({ offerId, provider: "LITEAPI", propertyName: "Hotel", trip, totalCents, refundable: true, source: "search" });
  pulse.observe([row("a", 90000), row("a", 85000), row("b", 70000)]);
  pulse.event({ type: "PROPOSAL_STALE", roomId: "room-secret-id", proposalId: "p1" });
  await pulse.flush();
  const insert = queries.find(q => q.sql.includes("accord_price_observations"))!;
  assert.deepEqual(insert.params[1], ["a", "b"]);
  assert.deepEqual(insert.params[8], [85000, 70000]);
  assert.deepEqual(insert.params[4], ["miami, fl", "miami, fl"]);
  assert.deepEqual(insert.params[6], [4, 4]);
  const event = queries.find(q => q.sql.includes("accord_events"))!;
  assert.notEqual(event.params[2], "room-secret-id", "room IDs are hashed before leaving Accord");
  assert.equal(event.params[5], "PROPOSAL_STALE");
});

test("a Tiger outage never throws into the booking flow", async () => {
  const pulse = new Pulse({ query: async () => { throw new Error("connection refused"); } } as any, 60_000);
  pulse.observe([{ offerId: "a", provider: "GOOGLE_HOTELS", propertyName: "House", trip, totalCents: 1, refundable: false, source: "search" }]);
  await pulse.flush();
  assert.match(pulse.lastError ?? "", /connection refused/);
});

test("LiteAPI search reports every returned rate that fits the group, not only the ones Accord keeps", async () => {
  const seen: PriceObservation[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const rate = (name: string, tag: string, amount: number, occupancy = 4) => ({ offerId: `${name}-${tag}`, rates: [{ name, maxOccupancy: occupancy, retailRate: { total: [{ amount, currency: "USD" }] }, cancellationPolicies: { refundableTag: tag } }] });
  const api = new LiteApi("sand_test", (async (url: string) => String(url).includes("/hotels/rates")
    ? json({ data: [{ hotelId: "H1", roomTypes: [rate("King", "NRFN", 800), rate("Twin", "NRFN", 850), rate("Queen", "RFN", 900), rate("Single", "RFN", 100, 1)] }], hotels: [{ id: "H1", name: "Test Hotel" }] })
    : json({ data: { name: "Test Hotel" } })) as typeof fetch, rows => seen.push(...rows));
  const stays = await api.search(trip);
  assert.equal(stays.length, 2, "Accord keeps the cheapest refundable and non-refundable rate");
  assert.equal(seen.length, 3, "Tiger sees all three rates that fit four guests");
  assert.ok(seen.every(row => row.propertyName === "Test Hotel" && row.source === "search"));
  assert.ok(stays.every(stay => seen.some(row => row.offerId === stay.offer.offerId)), "kept offers share IDs with their observations");
});
