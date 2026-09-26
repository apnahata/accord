import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { demoCatalog, OfferSchema } from "@accord/domain";
import { createApi } from "../src/server.js";
import { AccordState } from "../src/state.js";
import type { AlternativesInput } from "../src/coordinator.js";
import type { LiteApi } from "../src/stays.js";

const fast = { readyDelayMs: 0, replanDelayMs: 0, watchIntervalMs: 0 };
const canonical: Record<string, Record<string, unknown>> = {
  Alex: { maxContributionCents: 35000, softPreference: "lowest reasonable price" },
  Priya: { maxContributionCents: 45000, latestCheckOutAt: "2027-03-14T16:00:00.000Z", softPreference: "walkable neighborhood" },
  Jordan: { maxContributionCents: 45000, requiresFullCashRefund: true, softPreference: "near activities" },
  Mateo: { maxContributionCents: 45000, requiresStepFreeAccess: true, softPreference: "quiet property" },
};

async function waitFor<T>(read: () => Promise<T | undefined | false>, label: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function start(t: test.TestContext, autopilot = fast) {
  const app = createApi({ autopilot, geminiApiKey: "", geminiModel: "" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const call = async (path: string, method = "GET", body?: unknown, cookie?: string, key?: string) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  return { app, call };
}

async function group(call: Awaited<ReturnType<typeof start>>["call"], limits: Record<string, Record<string, unknown>>) {
  const [host, ...others] = Object.keys(limits);
  const created = await call("/rooms", "POST", { name: "Spring Break Stay", goal: "Shared stay", displayName: host });
  const roomId = created.data.roomId as string;
  const cookies: Record<string, string> = { [host!]: created.cookie! };
  for (const name of others) cookies[name] = (await call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName: name })).cookie!;
  for (const [name, limit] of Object.entries(limits)) {
    const confirmed = await call(`/rooms/${roomId}/me/constraints`, "POST", { requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", ...limit, confirmed: true }, cookies[name]);
    assert.equal(confirmed.status, 200);
  }
  return { roomId, cookies };
}

test("Accord searches on its own when everyone is ready, then replans a stale offer without anyone clicking", async t => {
  const { call } = await start(t);
  const { roomId, cookies } = await group(call, canonical);
  const room = (cookie = cookies.Alex) => call(`/rooms/${roomId}`, "GET", undefined, cookie);

  const firstId = await waitFor(async () => (await room()).data.activeProposalId as string | undefined, "the first autonomous proposal");
  const first = (await call(`/proposals/${firstId}/public`, "GET", undefined, cookies.Priya)).data.proposal;
  assert.equal(first.offer.offerId, "miami-ocean-walk");
  assert.equal(first.equalShareCents, 30000);
  assert.equal((await room()).data.autopilot.status, "WATCHING");
  for (const [name, cookie] of Object.entries(cookies)) {
    assert.equal((await call(`/proposals/${firstId}/consent`, "POST", { proposalHash: first.proposalHash, version: first.version, amountCents: 30000 }, cookie, `c-${name}-1`)).status, 200);
  }
  const hostInbox = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex)).data.messages;
  assert.ok(hostInbox.some((message: any) => message.kind === "READY_TO_BOOK"));

  assert.equal((await call("/merchant/events", "POST", { offerId: "miami-ocean-walk", expectedOfferVersion: "v1", mutation: { type: "INCREASE_PRICE", newTotalCents: 144000 } }, cookies.Alex)).status, 200);
  const secondId = await waitFor(async () => { const id = (await room()).data.activeProposalId; return id !== firstId && id; }, "the autonomous replan");
  const second = (await call(`/proposals/${secondId}/public`, "GET", undefined, cookies.Jordan)).data.proposal;
  assert.equal(second.offer.offerId, "tampa-river-court");
  assert.equal(second.equalShareCents, 28000);
  assert.equal(second.version, 2);
  assert.equal((await call(`/proposals/${firstId}/public`, "GET", undefined, cookies.Alex)).data.proposal.state, "STALE");

  const alexInbox = await waitFor(async () => {
    const messages = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex)).data.messages;
    return messages.find((message: any) => message.kind === "STALE_REASON") && messages;
  }, "Alex's private stale reason");
  assert.match(alexInbox.find((message: any) => message.kind === "STALE_REASON").body, /\$360\.00 share exceeds your confirmed maximum of \$350\.00/);
  assert.ok(!alexInbox.some((message: any) => message.kind === "READY_TO_BOOK"), "the ready-to-book note for the stale proposal is withdrawn");
  const priyaInbox = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Priya)).data.messages;
  assert.ok(priyaInbox.some((message: any) => message.kind === "STALE_REASON"));
  assert.ok(!JSON.stringify(priyaInbox).includes("$350"));

  const events = (await call(`/rooms/${roomId}/events`, "GET", undefined, cookies.Mateo)).data.events;
  assert.ok(events.some((event: any) => event.actor === "ACCORD" && /Accord found a new option: Tampa River Court/.test(event.title)));
  assert.ok(events.some((event: any) => event.actor === "ACCORD" && /Everyone has confirmed/.test(event.title)));
  assert.ok(!/35000|\$350|Alex|Priya|Jordan|Mateo/.test(JSON.stringify(events)));

  for (const [name, cookie] of Object.entries(cookies)) {
    assert.equal((await call(`/proposals/${secondId}/consent`, "POST", { proposalHash: second.proposalHash, version: 2, amountCents: 28000 }, cookie, `c-${name}-2`)).status, 200);
  }
  const booked = await call(`/proposals/${secondId}/execute`, "POST", { proposalHash: second.proposalHash }, cookies.Alex, `booking-${second.proposalHash}`);
  assert.equal(booked.data.status, "CONFIRMED");
});

test("when nothing fits, only the member who alone blocks an option is privately asked, and accepting replans", async t => {
  const { call } = await start(t);
  const { roomId, cookies } = await group(call, { ...canonical, Alex: { maxContributionCents: 27000, softPreference: "" } });
  const nudge = await waitFor(async () => (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex)).data.messages
    .find((message: any) => message.kind === "NUDGE" && message.nudge.status === "OPEN"), "Alex's private nudge");
  assert.match(nudge.body, /Tampa River Court/);
  assert.match(nudge.body, /\$280\.00, which is \$10\.00 over your \$270\.00 limit/);
  assert.equal(nudge.nudge.acceptLabel, "Raise my limit to $280.00");
  for (const name of ["Priya", "Jordan", "Mateo"]) {
    const inbox = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies[name])).data.messages;
    assert.ok(!inbox.some((message: any) => message.kind === "NUDGE"), `${name} is not asked`);
  }
  const publicRoom = (await call(`/rooms/${roomId}`, "GET", undefined, cookies.Priya)).data;
  assert.equal(publicRoom.autopilot.status, "NO_OPTION");
  assert.match(publicRoom.autopilot.message, /privately checked in with some members/);
  const events = (await call(`/rooms/${roomId}/events`, "GET", undefined, cookies.Priya)).data.events;
  assert.ok(!/27000|\$270/.test(JSON.stringify([publicRoom, events])));
  assert.ok(!/Alex/.test(JSON.stringify(events)));

  assert.equal((await call(`/rooms/${roomId}/me/inbox/${nudge.id}/respond`, "POST", { action: "ACCEPT" }, cookies.Priya)).data.code, "NUDGE_NOT_FOUND");
  const accepted = await call(`/rooms/${roomId}/me/inbox/${nudge.id}/respond`, "POST", { action: "ACCEPT" }, cookies.Alex);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.messages.find((message: any) => message.id === nudge.id).nudge.status, "ACCEPTED");
  assert.equal((await call(`/rooms/${roomId}/me/constraints`, "GET", undefined, cookies.Alex)).data.constraints.maxContributionCents, 28000);
  const proposalId = await waitFor(async () => (await call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data.activeProposalId as string | undefined, "the replan after accepting");
  const proposal = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookies.Alex)).data.proposal;
  assert.equal(proposal.offer.offerId, "tampa-river-court");
  assert.equal((await call(`/rooms/${roomId}/me/inbox/${nudge.id}/respond`, "POST", { action: "KEEP" }, cookies.Alex)).data.code, "NUDGE_CLOSED");
});

test("a member who keeps their limit is not asked again about the same stay", async t => {
  const { call } = await start(t);
  const { roomId, cookies } = await group(call, { ...canonical, Alex: { maxContributionCents: 27000, softPreference: "" } });
  const inbox = () => call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex);
  const nudge = await waitFor(async () => (await inbox()).data.messages.find((message: any) => message.kind === "NUDGE"), "the first nudge");
  assert.equal((await call(`/rooms/${roomId}/me/inbox/${nudge.id}/respond`, "POST", { action: "KEEP" }, cookies.Alex)).status, 200);
  assert.equal((await call(`/rooms/${roomId}/solve`, "POST", {}, cookies.Alex)).data.code, "NO_FEASIBLE_OFFER");
  const message = await waitFor(async () => { const room = (await call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data; return /Members can review/.test(room.autopilot.message) && room.autopilot.message; }, "the no-option message");
  assert.match(message, /host can change the trip/);
  assert.equal((await inbox()).data.messages.filter((item: any) => item.kind === "NUDGE").length, 1);
  assert.equal((await call(`/rooms/${roomId}/me/constraints`, "GET", undefined, cookies.Alex)).data.constraints.maxContributionCents, 27000);
});

test("the watch loop re-checks the offer, reminds only undecided members once, and replans when the offer lapses", async t => {
  const { app, call } = await start(t);
  const { roomId, cookies } = await group(call, { Alex: { maxContributionCents: 90000 }, Jordan: { maxContributionCents: 90000 } });
  const proposalId = await waitFor(async () => (await call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data.activeProposalId as string | undefined, "a proposal");
  const proposal = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookies.Alex)).data.proposal;
  const share = (await call(`/proposals/${proposalId}/me`, "GET", undefined, cookies.Alex)).data.myContributionCents;
  assert.equal((await call(`/proposals/${proposalId}/consent`, "POST", { proposalHash: proposal.proposalHash, version: proposal.version, amountCents: share }, cookies.Alex, "c-alex")).status, 200);

  await app.state.autopilot.tick(Date.now() + 10 * 60_000);
  const jordan = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Jordan)).data.messages;
  assert.match(jordan.find((message: any) => message.kind === "REMINDER").body, /1 of 2 members have approved/);
  assert.ok(!(await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Alex)).data.messages.some((message: any) => message.kind === "REMINDER"));
  const watched = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookies.Alex)).data.proposal;
  assert.equal(watched.watch.method, "RECORD");
  assert.ok(Date.parse(watched.watch.lastCheckedAt) > Date.parse(proposal.watch.lastCheckedAt));
  await app.state.autopilot.tick(Date.now() + 20 * 60_000);
  assert.equal((await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Jordan)).data.messages.filter((message: any) => message.kind === "REMINDER").length, 1);
  assert.equal((await call(`/proposals/${proposalId}/consent`, "POST", { proposalHash: proposal.proposalHash, version: proposal.version, amountCents: share }, cookies.Jordan, "c-jordan")).status, 200);
  assert.ok(!(await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Jordan)).data.messages.some((message: any) => message.kind === "REMINDER"), "the reminder is withdrawn once answered");

  await app.state.autopilot.tick(Date.parse(proposal.expiresAt) + 1000);
  assert.equal((await call(`/proposals/${proposalId}/public`, "GET", undefined, cookies.Alex)).data.proposal.state, "STALE");
  const events = (await call(`/rooms/${roomId}/events`, "GET", undefined, cookies.Alex)).data.events;
  assert.ok(events.some((event: any) => /The offer expired/.test(event.title)));
});

test("with live search, Accord asks Gemini for nearby areas and proposes a stay there when the original city has none", async t => {
  const trip = { destination: "Testville, FL", countryCode: "US", checkIn: "2027-03-10", checkOut: "2027-03-14", guests: 2, timeZone: "America/New_York" };
  const stay = (destination: string, totalCents: number) => {
    const offer = OfferSchema.parse({ ...demoCatalog()[0]!, offerId: `lite-${destination}`, propertyId: `hotel-${destination}`, propertyName: `${destination} Hotel`,
      city: destination.split(",")[0], source: "LITEAPI", bookingMode: "SANDBOX", totalCents, subtotalCents: totalCents, mandatoryFeesCents: 0 });
    return { offer, research: { sourceLabel: "test", pros: [], cons: [], nearby: [] }, ref: { provider: "LITEAPI" as const, hotelId: offer.propertyId, offerId: offer.offerId, roomName: "Room", refundableTag: "RFN" } };
  };
  const searched: string[] = [], asked: AlternativesInput[] = [];
  const liteApi = { search: async (value: typeof trip) => { searched.push(value.destination); return [value.destination.startsWith("Nearby") ? stay(value.destination, 80000) : stay(value.destination, 400000)]; } } as unknown as LiteApi;
  const state = new AccordState(undefined, { liteApi, suggestAlternatives: async input => { asked.push(input); return ["Testville, FL", "Nearby, FL"]; } }, fast);
  t.after(() => { state.autopilot.dispose(); state.streams.close(); });
  await state.ready;
  const created = state.createRoom("Trip", "Stay", "Alex", trip);
  const joined = state.join(created.inviteToken, "Jordan");
  const room = state.rooms.get(created.roomId)!;
  for (const id of room.memberIds) state.confirmConstraints(room, state.members.get(id)!, { maxContributionCents: 50000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "" });
  assert.ok(joined.roomId);

  const proposalId = await waitFor(async () => room.activeProposalId, "a proposal from the nearby area");
  assert.equal(state.proposals.get(proposalId)!.snapshot.offer.propertyName, "Nearby, FL Hotel");
  assert.deepEqual(searched, ["Testville, FL", "Nearby, FL"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.staysFailing.BUDGET, 1);
  assert.ok(!/50000|Alex|Jordan/.test(JSON.stringify(asked)));
  assert.ok(room.events.some(event => event.actor === "ACCORD" && /Accord is also searching Nearby, FL/.test(event.title)));
});
