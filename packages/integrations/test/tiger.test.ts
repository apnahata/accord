import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { Tiger } from "../src/tiger.js";
import type { TigerEvent } from "../src/tiger.js";
const event: TigerEvent = { eventId: "event-1", time: "2026-09-26T00:00:00Z", roomId: "room-1", eventType: "OFFER_OBSERVED", offerId: "offer-1", publicMetadata: { totalCents: 120000, available: true } };

test("Tiger unavailable does not invent events or stability", async () => {
  assert.equal((await new Tiger().write(event)).status, "UNAVAILABLE");
  assert.equal((await new Tiger().stability("room", event.time)).status, "UNAVAILABLE");
});
test("Tiger rejects private metadata before writing", async () => {
  let writes = 0;
  const tiger = new Tiger({ query: async () => { writes++; return { rows: [] }; } } as unknown as Pick<Pool, "query">);
  const result = await tiger.write({ ...event, publicMetadata: { ...event.publicMetadata, maxContributionCents: 35000 } } as TigerEvent);
  assert.equal(result.status, "FAILED"); assert.equal(writes, 0);
});
test("Tiger uses parameterized insert and explicit room scope in queries", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tiger = new Tiger({ query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [] }; } } as unknown as Pick<Pool, "query">);
  assert.equal((await tiger.write(event)).status, "OK");
  await tiger.timeline("room'OR TRUE--", event.time);
  assert.ok(calls[0]?.sql.includes("ON CONFLICT"));
  assert.equal(calls[0]?.values[2], "room-1");
  assert.ok(calls[1]?.sql.includes("room_id=$1"));
  assert.equal(calls[1]?.sql.includes("room'OR"), false);
});
test("stability is derived from query results, with no artificial zero-observation offers", async () => {
  const tiger = new Tiger({ query: async () => ({ rows: [
    { offer_id: "a", observation_count: 3, material_change_count: 2, price_change_count: 1, terms_change_count: 1 },
    { offer_id: "b", observation_count: 1, material_change_count: 0, price_change_count: 0, terms_change_count: 0 },
  ] }) } as unknown as Pick<Pool, "query">);
  const result = await tiger.stability("room", event.time);
  assert.equal(result.status, "OK");
  if (result.status === "OK") assert.deepEqual(result.value.map(value => value.label), ["VOLATILE", "STABLE"]);
});
