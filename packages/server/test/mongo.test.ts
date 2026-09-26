import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { createApi } from "../src/server.js";
import { MongoPersistence } from "../src/persistence.js";

// Runs against a real Mongo replica set (e.g. Atlas) only when MONGODB_URI is set. Uses and drops a throwaway database.
const uri = process.env.MONGODB_URI;

test("room, private constraints, consent and booking survive a coordinator restart", { skip: !uri && "MONGODB_URI not set", timeout: 180_000 }, async t => {
  const dbName = `accord_test_${randomBytes(4).toString("hex")}`;
  const key = randomBytes(32).toString("base64");
  const raw = new MongoClient(uri!);
  t.after(async () => { await raw.db(dbName).dropDatabase(); await raw.close(); });

  async function boot() {
    const persistence = await MongoPersistence.connect(uri!, dbName, key);
    const app = createApi({ persistence });
    await app.state.ready;
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const stop = async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await persistence.close(); };
    const call = async (path: string, method = "GET", body?: unknown, cookie?: string, idempotencyKey?: string) => {
      const response = await fetch(`${base}/api${path}`, {
        method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, data: await response.json() as any };
    };
    return { call, stop };
  }

  let api = await boot();
  assert.equal((await api.call("/health")).data.mongo, "UP");
  const created = await api.call("/rooms", "POST", { name: "Spring Break Stay", goal: "Shared stay", displayName: "Alex" });
  assert.equal(created.response.status, 201);
  const roomId = created.data.roomId;
  const cookies: Record<string, string> = { Alex: created.response.headers.get("set-cookie")!.split(";")[0]! };
  for (const displayName of ["Priya", "Jordan", "Mateo"]) {
    const joined = await api.call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName });
    cookies[displayName] = joined.response.headers.get("set-cookie")!.split(";")[0]!;
  }
  for (const [displayName, cookie] of Object.entries(cookies)) {
    const confirmed = await api.call(`/rooms/${roomId}/me/constraints`, "POST", {
      maxContributionCents: displayName === "Alex" ? 35000 : 45000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "lowest reasonable price", confirmed: true }, cookie);
    assert.equal(confirmed.response.status, 200);
  }
  const proposal = (await api.call(`/rooms/${roomId}/solve`, "POST", {}, cookies.Alex)).data.proposal;
  for (const [displayName, cookie] of Object.entries(cookies)) {
    const consent = await api.call(`/proposals/${proposal.proposalId}/consent`, "POST", { proposalHash: proposal.proposalHash, version: proposal.version, amountCents: proposal.equalShareCents }, cookie, `consent-${displayName}`);
    assert.equal(consent.response.status, 200);
  }

  // Private constraints are only stored encrypted.
  const alexDoc = await raw.db(dbName).collection("members").findOne({ displayName: "Alex" });
  assert.ok(alexDoc?.sealedConstraints?.data);
  assert.ok(!JSON.stringify(alexDoc).includes("35000"));

  await api.stop();
  api = await boot(); // Simulated coordinator restart: all state must come back from Mongo.

  const room = await api.call(`/rooms/${roomId}`, "GET", undefined, cookies.Priya);
  assert.equal(room.response.status, 200);
  assert.equal(room.data.readyMemberCount, 4);
  const mine = await api.call(`/rooms/${roomId}/me/constraints`, "GET", undefined, cookies.Alex);
  assert.equal(mine.data.constraints.maxContributionCents, 35000);
  const restored = await api.call(`/proposals/${proposal.proposalId}/public`, "GET", undefined, cookies.Alex);
  assert.equal(restored.data.proposal.authorization.authorizedCount, 4);
  assert.equal(restored.data.canExecute, true);
  const unrelated = await api.call("/merchant/events", "POST", { offerId: "tampa-river-court", expectedOfferVersion: "v1", mutation: { type: "INCREASE_PRICE", newTotalCents: 130000 } }, cookies.Alex);
  assert.equal(unrelated.data.offerVersion, "v2");
  assert.equal(await raw.db(dbName).collection("merchant_outbox").countDocuments({ deliveredAt: { $exists: false } }), 0);

  const booked = await api.call(`/proposals/${proposal.proposalId}/execute`, "POST", { proposalHash: proposal.proposalHash }, cookies.Alex, `booking-${proposal.proposalHash}`);
  assert.equal(booked.response.status, 200);
  assert.equal(booked.data.status, "CONFIRMED");
  await api.stop();

  api = await boot();
  const receipt = await api.call(`/rooms/${roomId}/receipt`, "GET", undefined, cookies.Jordan);
  assert.equal(receipt.data.bookingReference, booked.data.bookingReference);
  assert.equal(await raw.db(dbName).collection("merchant_bookings").countDocuments(), 1);
  await api.stop();
});
