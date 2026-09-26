import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { addDays, localDay } from "@accord/domain";
import { createApi } from "../src/server.js";
import { MongoPersistence } from "../src/persistence.js";
import type { AutopilotOptions } from "../src/coordinator.js";

// Runs against a real Mongo replica set (e.g. Atlas) only when MONGODB_URI is set. Uses and drops a throwaway database.
const uri = process.env.MONGODB_URI;
const skip = !uri && "MONGODB_URI not set";

function throwawayDatabase(t: test.TestContext) {
  const dbName = `accord_test_${randomBytes(4).toString("hex")}`;
  const key = randomBytes(32).toString("base64");
  const raw = new MongoClient(uri!);
  const running = new Set<() => Promise<void>>();
  t.after(async () => { for (const stop of running) await stop().catch(() => undefined); await raw.db(dbName).dropDatabase(); await raw.close(); });
  async function boot(autopilot?: AutopilotOptions) {
    const persistence = await MongoPersistence.connect(uri!, dbName, key);
    const app = createApi({ persistence, ...(autopilot ? { autopilot } : {}) });
    await app.state.ready;
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const stop = async () => { running.delete(stop); app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await persistence.close(); };
    running.add(stop);
    const call = async (path: string, method = "GET", body?: unknown, cookie?: string, idempotencyKey?: string) => {
      const response = await fetch(`${base}/api${path}`, {
        method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, data: await response.json() as any };
    };
    return { call, stop };
  }
  return { raw, dbName, boot };
}

async function waitFor<T>(read: () => Promise<T | undefined | false>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("room, private constraints, consent and booking survive a coordinator restart", { skip, timeout: 180_000 }, async t => {
  const { raw, dbName, boot } = throwawayDatabase(t);
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
  await api.call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName: "Ghost" });
  const ghost = (await api.call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data.members.find((m: any) => m.displayName === "Ghost");
  assert.equal((await api.call(`/rooms/${roomId}/members/${ghost.id}`, "DELETE", undefined, cookies.Alex)).response.status, 200);
  assert.equal(await raw.db(dbName).collection("members").countDocuments({ _id: ghost.id } as any), 0);
  assert.equal(await raw.db(dbName).collection("sessions").countDocuments({ memberId: ghost.id }), 0);
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

test("Accord's private nudge and proposal watch state survive a coordinator restart, sealed at rest", { skip, timeout: 180_000 }, async t => {
  const { raw, dbName, boot } = throwawayDatabase(t);
  const fast: AutopilotOptions = { readyDelayMs: 0, replanDelayMs: 0, watchIntervalMs: 300, recheckEveryMs: 0 };
  let api = await boot(fast);
  const created = await api.call("/rooms", "POST", { name: "Spring Break Stay", goal: "Shared stay", displayName: "Alex" });
  const roomId = created.data.roomId;
  const cookies: Record<string, string> = { Alex: created.response.headers.get("set-cookie")!.split(";")[0]! };
  for (const displayName of ["Priya", "Jordan", "Mateo"]) {
    const joined = await api.call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName });
    cookies[displayName] = joined.response.headers.get("set-cookie")!.split(";")[0]!;
  }
  const limits: Record<string, Record<string, unknown>> = {
    Alex: { maxContributionCents: 27000 },
    Priya: { maxContributionCents: 45000, latestCheckOutAt: "2027-03-14T16:00:00.000Z" },
    Jordan: { maxContributionCents: 45000, requiresFullCashRefund: true },
    Mateo: { maxContributionCents: 45000, requiresStepFreeAccess: true },
  };
  for (const [displayName, cookie] of Object.entries(cookies)) {
    const confirmed = await api.call(`/rooms/${roomId}/me/constraints`, "POST", { requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", ...limits[displayName], confirmed: true }, cookie);
    assert.equal(confirmed.response.status, 200);
  }
  const nudge = await waitFor(async () => (await api.call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex)).data.messages
    .find((message: any) => message.kind === "NUDGE" && message.nudge.status === "OPEN"), "Alex's private nudge");
  await waitFor(async () => (await raw.db(dbName).collection("members").findOne({ displayName: "Alex" }))?.sealedInbox?.data, "the sealed inbox write");

  const alexDoc = await raw.db(dbName).collection("members").findOne({ displayName: "Alex" });
  assert.ok(!/Tampa|\$270|27000|28000/.test(JSON.stringify(alexDoc)), "the nudge is stored only as ciphertext");
  assert.equal((await raw.db(dbName).collection("members").findOne({ displayName: "Priya" }))?.sealedInbox ?? null, null);

  await api.stop();
  api = await boot(fast);
  const restored = (await api.call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex)).data.messages.find((message: any) => message.id === nudge.id);
  assert.equal(restored.nudge.status, "OPEN");
  assert.equal(restored.body, nudge.body);
  assert.equal((await api.call(`/rooms/${roomId}/me/inbox/${nudge.id}/respond`, "POST", { action: "ACCEPT" }, cookies.Alex)).response.status, 200);
  const proposalId = await waitFor(async () => (await api.call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data.activeProposalId as string | undefined, "the replan after accepting");
  await waitFor(async () => (await raw.db(dbName).collection("proposals").findOne({ _id: proposalId } as any))?.watch?.lastCheckedAt, "the persisted watch state");
  const watched = (await api.call(`/proposals/${proposalId}/public`, "GET", undefined, cookies.Priya)).data.proposal;
  assert.equal(watched.offer.offerId, "tampa-river-court");

  await api.stop();
  const persisted = (await raw.db(dbName).collection("proposals").findOne({ _id: proposalId } as any))!.watch.lastCheckedAt;
  api = await boot({ ...fast, watchIntervalMs: 0 });
  const afterRestart = (await api.call(`/proposals/${proposalId}/public`, "GET", undefined, cookies.Priya)).data.proposal;
  assert.equal(afterRestart.watch.lastCheckedAt, persisted);
  assert.equal(afterRestart.watch.method, "RECORD");
  const answered = (await api.call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex)).data.messages.find((message: any) => message.id === nudge.id);
  assert.equal(answered.nudge.status, "ACCEPTED");
  assert.equal((await api.call(`/rooms/${roomId}/me/constraints`, "GET", undefined, cookies.Alex)).data.constraints.maxContributionCents, 28000);
  await api.stop();
});

test("an open trip vote survives a coordinator restart with every ballot sealed at rest", { skip, timeout: 180_000 }, async t => {
  const { raw, dbName, boot } = throwawayDatabase(t);
  const fast: AutopilotOptions = { readyDelayMs: 0, replanDelayMs: 0, watchIntervalMs: 0 };
  const today = localDay(new Date().toISOString());
  let api = await boot(fast);
  const created = await api.call("/rooms", "POST", { name: "Spring Trip", displayName: "Alex", plan: { earliest: addDays(today, 30), latest: addDays(today, 60), nights: 3 }, rehearsal: true });
  const roomId = created.data.roomId;
  const cookies: Record<string, string> = { Alex: created.response.headers.get("set-cookie")!.split(";")[0]! };
  for (const displayName of ["Priya", "Jordan"]) {
    const joined = await api.call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName });
    cookies[displayName] = joined.response.headers.get("set-cookie")!.split(";")[0]!;
  }
  for (const [displayName, cookie] of Object.entries(cookies)) {
    const answer = { requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", maxContributionCents: 200000, tripStyles: displayName === "Jordan" ? ["SKI"] : ["BEACH", "CITY"], confirmed: true };
    assert.equal((await api.call(`/rooms/${roomId}/me/constraints`, "POST", answer, cookie)).response.status, 200);
  }
  const options = await waitFor(async () => { const room = (await api.call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data; return room.planning?.stage === "VOTING" && room.planning.options; }, "the shortlist");
  const pick = options[options.length - 1];
  assert.equal((await api.call(`/rooms/${roomId}/plan/vote`, "POST", { optionId: pick.id }, cookies.Priya)).response.status, 200);
  await waitFor(async () => (await raw.db(dbName).collection("rooms").findOne({ _id: roomId } as any))?.planning?.sealedVotes?.data, "the sealed ballot write");
  const doc = await raw.db(dbName).collection("rooms").findOne({ _id: roomId } as any);
  assert.deepEqual(doc!.planning.votes, {});
  assert.ok(!JSON.stringify(doc!.planning.sealedVotes).includes(pick.id), "ballots are stored only as ciphertext");

  await api.stop();
  api = await boot(fast);
  const restored = (await api.call(`/rooms/${roomId}`, "GET", undefined, cookies.Priya)).data.planning;
  assert.equal(restored.stage, "VOTING");
  assert.equal(restored.myVoteOptionId, pick.id);
  assert.equal(restored.votesCast, 1);
  for (const name of ["Alex", "Jordan"]) await api.call(`/rooms/${roomId}/plan/vote`, "POST", { optionId: pick.id }, cookies[name]);
  const decided = await waitFor(async () => { const room = (await api.call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data; return room.activeProposalId && room; }, "the winner's proposal");
  assert.equal(decided.trip.destination, pick.destination);
  assert.equal(decided.planning.decidedBy, "VOTE");
  await api.stop();
});
