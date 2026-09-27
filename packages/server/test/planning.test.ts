import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { addDays, ConstraintsSchema, DESTINATIONS, localDay } from "@accord/domain";
import { createApi } from "../src/server.js";
import { AccordState, dayRange } from "../src/state.js";
import type { DestinationIdea, DestinationsInput } from "../src/planner.js";

const fast = { readyDelayMs: 0, replanDelayMs: 0, watchIntervalMs: 0 };
const today = localDay(new Date().toISOString());
const day = (offset: number) => addDays(today, offset);
const base = { requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", maxContributionCents: 200000, availability: [{ from: day(30), to: day(60) }] };

async function waitFor<T>(read: () => Promise<T | undefined | false>, label: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function start(t: test.TestContext) {
  const app = createApi({ autopilot: fast, geminiApiKey: "", geminiModel: "" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  return async (path: string, method = "GET", body?: unknown, cookie?: string, key?: string) => {
    const response = await fetch(url + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
}
type Call = Awaited<ReturnType<typeof start>>;

async function plannedGroup(call: Call, answers: Record<string, Record<string, unknown>>) {
  const [host, ...others] = Object.keys(answers);
  const created = await call("/rooms", "POST", { name: "Spring Trip", displayName: host, plan: {}, rehearsal: true });
  assert.equal(created.status, 201);
  const roomId = created.data.roomId as string;
  const cookies: Record<string, string> = { [host!]: created.cookie! };
  for (const name of others) cookies[name] = (await call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName: name })).cookie!;
  for (const [name, answer] of Object.entries(answers)) {
    assert.equal((await call(`/rooms/${roomId}/me/constraints`, "POST", { ...base, ...answer, confirmed: true }, cookies[name])).status, 200);
  }
  return { roomId, cookies };
}

test("Accord plans where and when from private answers, runs a private vote, and books the winner", async t => {
  const call = await start(t);
  const { roomId, cookies } = await plannedGroup(call, {
    Alex: { availability: [{ from: day(30), to: day(45) }], tripStyles: ["BEACH"] },
    Priya: { availability: [{ from: day(35), to: day(60) }], tripStyles: ["BEACH", "CITY"] },
    Jordan: { tripStyles: ["SKI"], placesToAvoid: "anywhere in Florida" },
    Mateo: { availability: [{ from: day(33), to: day(50) }], tripStyles: ["BEACH"] },
  });
  const room = async (cookie = cookies.Alex) => (await call(`/rooms/${roomId}`, "GET", undefined, cookie)).data;

  const voting = await waitFor(async () => { const data = await room(); return data.planning?.stage === "VOTING" && data; }, "the shortlist");
  assert.equal(voting.autopilot.status, "VOTING");
  assert.equal(voting.trip, undefined);
  assert.deepEqual(voting.planning.windows[0], { checkIn: day(35), checkOut: day(38) });
  const names: string[] = voting.planning.destinations.map((item: any) => item.name);
  assert.equal(names.length, 3);
  assert.ok(names.every(name => !name.endsWith(", FL")), "a place someone ruled out never reaches the shortlist");
  assert.equal(voting.planning.options.length, 3);
  assert.ok(voting.planning.options.every((option: any) => option.votes === undefined), "totals stay hidden while voting is open");
  assert.deepEqual(voting.planning.styles, [{ style: "BEACH", count: 3 }, { style: "CITY", count: 1 }, { style: "SKI", count: 1 }]);
  const exposed = JSON.stringify(voting);
  for (const secret of ["Florida", "200000", "availability", "placesToAvoid", day(45)]) assert.ok(!exposed.includes(secret), `room view leaked ${secret}`);
  const inbox = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Jordan)).data.messages;
  assert.ok(inbox.some((message: any) => message.title === "Vote on where you’re going"));

  // The group's pick doesn't have to be Accord's top fit.
  const [best, , underdog] = voting.planning.options;
  for (const name of ["Alex", "Priya", "Jordan"]) assert.equal((await call(`/rooms/${roomId}/plan/vote`, "POST", { optionId: underdog.id }, cookies[name])).status, 200);
  const mine = await room(cookies.Priya);
  assert.equal(mine.planning.myVoteOptionId, underdog.id);
  assert.equal(mine.planning.votesCast, 3);
  assert.equal((await room(cookies.Mateo)).planning.myVoteOptionId, undefined);
  assert.equal((await call(`/rooms/${roomId}/plan/vote`, "POST", { optionId: best.id }, cookies.Mateo)).status, 200);

  const decided = await waitFor(async () => { const data = await room(); return data.activeProposalId && data; }, "Proposal v1 for the winner");
  assert.equal(decided.planning.stage, "DECIDED");
  assert.equal(decided.planning.decidedBy, "VOTE");
  assert.deepEqual(decided.planning.options.map((option: any) => option.votes), [1, 0, 3]);
  assert.equal(decided.trip.destination, underdog.destination);
  assert.equal(decided.trip.checkIn, underdog.checkIn);
  assert.equal((await call(`/rooms/${roomId}/plan/vote`, "POST", { optionId: best.id }, cookies.Mateo)).status, 409);
  const after = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Jordan)).data.messages;
  assert.ok(!after.some((message: any) => message.kind === "VOTE"), "the call to vote disappears once voting closes");

  const proposal = (await call(`/proposals/${decided.activeProposalId}/public`, "GET", undefined, cookies.Alex)).data.proposal;
  assert.equal(proposal.offer.city, underdog.destination);
  assert.equal(proposal.offer.timeZone, DESTINATIONS.find(item => item.name === underdog.destination)!.timeZone);
  assert.equal(proposal.offer.source, "DEMO");
  const own = (await call(`/proposals/${decided.activeProposalId}/me`, "GET", undefined, cookies.Alex)).data;
  assert.equal(own.myConstraintChecks.find((check: any) => check.kind === "DATES").status, "PASS");
  for (const [name, cookie] of Object.entries(cookies)) {
    assert.equal((await call(`/proposals/${proposal.proposalId}/consent`, "POST", { proposalHash: proposal.proposalHash, version: proposal.version, amountCents: proposal.equalShareCents }, cookie, `c-${name}`)).status, 200);
  }
  const receipt = await call(`/proposals/${proposal.proposalId}/execute`, "POST", { proposalHash: proposal.proposalHash }, cookies.Alex, "book-1");
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.status, "CONFIRMED");
});

test("when no dates work for everyone, Accord privately asks only the one member who blocks, and saying yes restarts planning", async t => {
  const call = await start(t);
  const { roomId, cookies } = await plannedGroup(call, {
    Alex: { availability: [{ from: day(30), to: day(40) }], tripStyles: ["MOUNTAINS"] },
    Priya: { availability: [{ from: day(30), to: day(40) }], tripStyles: ["MOUNTAINS"] },
    Jordan: { availability: [{ from: day(50), to: day(60) }], tripStyles: ["CITY"] },
  });
  const room = async () => (await call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data;
  const stuck = await waitFor(async () => { const data = await room(); return data.planning?.stage === "NO_OPTION" && data; }, "the date conflict");
  assert.equal(stuck.autopilot.status, "NO_OPTION");
  assert.match(stuck.autopilot.message, /privately checked in/);
  for (const name of ["Alex", "Priya"]) assert.ok(!(await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies[name])).data.messages.some((message: any) => message.kind === "NUDGE"));
  const nudge = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Jordan)).data.messages.find((message: any) => message.kind === "NUDGE");
  assert.equal(nudge.nudge.check, "DATES");
  assert.match(nudge.nudge.acceptLabel, /^I can make /);
  assert.ok(!JSON.stringify(nudge).includes("Alex") && !JSON.stringify(nudge).includes("Priya"));

  assert.equal((await call(`/rooms/${roomId}/me/inbox/${nudge.id}/respond`, "POST", { action: "ACCEPT" }, cookies.Jordan)).status, 200);
  const replanned = await waitFor(async () => { const data = await room(); return ["VOTING", "DECIDED"].includes(data.planning?.stage) && data; }, "planning after Jordan's yes");
  // The ask is the shared window closest to Jordan's own dates.
  assert.deepEqual(replanned.planning.windows[0], { checkIn: day(37), checkOut: day(40) });
  const capsule = (await call(`/rooms/${roomId}/me/constraints`, "GET", undefined, cookies.Jordan)).data.constraints;
  assert.deepEqual(capsule.availability, [{ from: day(50), to: day(60) }, { from: day(37), to: day(40) }]);
});

test("when two members could each unblock the dates, one yes retires the other's question", async t => {
  const call = await start(t);
  const { roomId, cookies } = await plannedGroup(call, {
    Alex: { availability: [{ from: day(35), to: day(44) }], tripStyles: ["CITY"] },
    Mateo: { availability: [{ from: day(30), to: day(42) }], tripStyles: ["CITY"] },
    // Everyone overlaps for one night only, too short to plan without someone moving.
    Priya: { availability: [{ from: day(41), to: day(49) }], tripStyles: ["BEACH"] },
  });
  const ask = (name: string) => waitFor(async () => (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies[name])).data.messages
    .find((message: any) => message.kind === "NUDGE"), `${name}'s date question`);
  const [priya, mateo] = [await ask("Priya"), await ask("Mateo")];
  assert.equal(priya.nudge.acceptLabel, `I can make ${dayRange({ checkIn: day(39), checkOut: day(42) })}`);
  assert.equal(mateo.nudge.acceptLabel, `I can make ${dayRange({ checkIn: day(41), checkOut: day(44) })}`);

  assert.equal((await call(`/rooms/${roomId}/me/inbox/${priya.id}/respond`, "POST", { action: "ACCEPT" }, cookies.Priya)).status, 200);
  await waitFor(async () => (await call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data.planning?.stage === "VOTING", "the shortlist");
  const retired = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Mateo)).data.messages.find((message: any) => message.id === mateo.id);
  assert.equal(retired.nudge.status, "EXPIRED");
  assert.equal((await call(`/rooms/${roomId}/me/inbox/${mateo.id}/respond`, "POST", { action: "ACCEPT" }, cookies.Mateo)).status, 409);
  assert.deepEqual((await call(`/rooms/${roomId}/me/constraints`, "GET", undefined, cookies.Mateo)).data.constraints.availability, [{ from: day(30), to: day(42) }]);
});

test("when one member's avoid list rules out every destination, Accord privately asks only them, and accepting unblocks planning", async t => {
  const call = await start(t);
  const everyCity = DESTINATIONS.map(item => item.name.split(",")[0]).join(", ");
  const { roomId, cookies } = await plannedGroup(call, {
    Alex: { tripStyles: ["CITY"] },
    Priya: { tripStyles: ["CITY"] },
    Jordan: { tripStyles: ["CITY"], placesToAvoid: everyCity },
  });
  const room = async () => (await call(`/rooms/${roomId}`, "GET", undefined, cookies.Alex)).data;
  const stuck = await waitFor(async () => { const data = await room(); return data.planning?.stage === "NO_OPTION" && data; }, "the destination conflict");
  assert.match(stuck.autopilot.message, /privately checked in/);
  for (const name of ["Alex", "Priya"]) assert.ok(!(await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies[name])).data.messages.some((message: any) => message.kind === "NUDGE"));
  const nudge = (await call(`/rooms/${roomId}/me/inbox`, "GET", undefined, cookies.Jordan)).data.messages.find((message: any) => message.kind === "NUDGE");
  assert.equal(nudge.nudge.check, "PLACE");
  assert.equal(nudge.nudge.acceptLabel, "Drop that for this trip");
  assert.ok(!JSON.stringify(nudge).includes("Alex") && !JSON.stringify(nudge).includes("Priya"));

  assert.equal((await call(`/rooms/${roomId}/me/inbox/${nudge.id}/respond`, "POST", { action: "ACCEPT" }, cookies.Jordan)).status, 200);
  await waitFor(async () => { const data = await room(); return ["VOTING", "DECIDED"].includes(data.planning?.stage) && data; }, "planning after Jordan's yes");
  const capsule = (await call(`/rooms/${roomId}/me/constraints`, "GET", undefined, cookies.Jordan)).data.constraints;
  assert.equal(capsule.placesToAvoid, undefined);
});

function plannedState(suggest?: (input: DestinationsInput) => Promise<DestinationIdea[] | undefined>) {
  const state = new AccordState(undefined, suggest ? { suggestDestinations: suggest } : {}, { enabled: false, watchIntervalMs: 0 });
  const created = state.createRoom("Trip", "Plan it", "Alex", undefined, undefined, { plan: { countryCode: "US" }, rehearsal: true });
  const room = state.rooms.get(created.roomId)!;
  state.join(created.inviteToken, "Priya");
  const [alex, priya] = room.memberIds.map(id => state.members.get(id)!);
  return { state, room, alex: alex!, priya: priya! };
}

test("destination suggestions see only anonymous totals, and can't bring back a place someone ruled out", async () => {
  let seen: DestinationsInput | undefined;
  const { state, room, alex, priya } = plannedState(async input => {
    seen = input;
    return [
      { name: "Miami, FL", timeZone: "America/New_York", styles: ["BEACH"], why: "Beaches." },
      { name: "Boston, MA", timeZone: "America/New_York", styles: ["CITY"], why: "Close by." },
      { name: "Asheville, NC", timeZone: "America/New_York", styles: ["MOUNTAINS"], why: "Mountain town." },
      { name: "Bend, OR", timeZone: "Not/AZone", styles: ["NATURE"], why: "Outdoors." },
    ];
  });
  state.confirmConstraints(room, alex, ConstraintsSchema.parse({ ...base, maxContributionCents: 123456, tripStyles: ["BEACH"], placeIdeas: "somewhere warm", leavingFrom: "Philadelphia" }));
  state.confirmConstraints(room, priya, ConstraintsSchema.parse({ ...base, tripStyles: ["MOUNTAINS"], placesToAvoid: "not Miami", leavingFrom: "Boston" }));
  await state.autopilot.planNow(room);

  assert.deepEqual(seen!.styleCounts, { BEACH: 1, MOUNTAINS: 1 });
  assert.deepEqual(seen!.ideas, ["somewhere warm"]);
  assert.deepEqual(seen!.from, ["Boston", "Philadelphia"], "departures are sorted so they can't be matched to people");
  assert.equal(seen!.nights, 3);
  const sent = JSON.stringify(seen);
  for (const secret of ["Alex", "Priya", "123456", "200000", alex.id, priya.id]) assert.ok(!sent.includes(secret), `suggestion input leaked ${secret}`);
  const view = state.roomDTO(room, alex.id).planning!;
  assert.equal(view.stage, "VOTING");
  assert.deepEqual(view.destinations.map(item => item.name), ["Asheville, NC", "Bend, OR"], "no ruled-out place, and nowhere someone lives");
  assert.equal(room.planning!.destinations[1]!.timeZone, "America/New_York");

  // One vote and then the deadline: Accord closes the vote with what was cast.
  state.autopilot.planner.vote(room, priya.id, view.options.find(option => option.destination === "Bend, OR")!.id);
  await state.autopilot.tick(Date.now() + 2 * 86_400_000);
  const closed = state.roomDTO(room, alex.id);
  assert.equal(closed.planning!.stage, "DECIDED");
  assert.equal(closed.planning!.decidedBy, "DEADLINE");
  assert.equal(closed.trip!.destination, "Bend, OR");
});

test("a tied vote goes to the better fit and says so, and stays show their own destination's time zone", async () => {
  const { state, room, alex, priya } = plannedState(async () => [
    { name: "Bend, OR", timeZone: "America/Los_Angeles", styles: ["MOUNTAINS", "NATURE"], why: "Outdoors." },
    { name: "Asheville, NC", timeZone: "America/New_York", styles: ["MOUNTAINS"], why: "Mountain town." },
  ]);
  state.confirmConstraints(room, alex, ConstraintsSchema.parse({ ...base, tripStyles: ["MOUNTAINS", "NATURE"] }));
  state.confirmConstraints(room, priya, ConstraintsSchema.parse({ ...base, tripStyles: ["MOUNTAINS"] }));
  await state.autopilot.planNow(room);
  const [best, other] = state.roomDTO(room, alex.id).planning!.options;
  const offers = (await state.offers(room)).offers;
  assert.ok(offers.some(offer => offer.city === "Bend, OR"));
  for (const offer of offers) assert.equal(offer.timeZone, offer.city === "Bend, OR" ? "America/Los_Angeles" : "America/New_York", offer.city);

  state.autopilot.planner.vote(room, alex.id, other!.id);
  state.autopilot.planner.vote(room, priya.id, best!.id);
  await state.autopilot.planner.closeVote(room, "VOTE");
  assert.equal(state.roomDTO(room, alex.id).trip!.destination, best!.destination);
  assert.ok(room.events.some(event => event.title.includes(`tie at 1 vote each, so Accord went with the trip that fits the group best: ${best!.destination}`)), "the timeline says the vote was tied");
});

test("the host only names the group, and everyone must say when they're free", async t => {
  const call = await start(t);
  assert.equal((await call("/rooms", "POST", { name: "Trip", displayName: "Alex", plan: { earliest: day(30), latest: day(60), nights: 3 } })).status, 422);
  const created = await call("/rooms", "POST", { name: "Trip", displayName: "Alex", plan: {}, rehearsal: true });
  assert.equal(created.status, 201);
  const room = (await call(`/rooms/${created.data.roomId}`, "GET", undefined, created.cookie)).data;
  assert.deepEqual(room.planning.horizon, { earliest: day(1), latest: day(180) });
  const { availability: _dates, ...undated } = base;
  const refused = await call(`/rooms/${created.data.roomId}/me/constraints`, "POST", { ...undated, confirmed: true }, created.cookie);
  assert.equal(refused.status, 422);
  assert.equal(refused.data.code, "DATES_REQUIRED");
});

test("the trip is as long as most people want, and shorter only when that's the only way everyone can go", async () => {
  const first = plannedState();
  first.state.confirmConstraints(first.room, first.alex, ConstraintsSchema.parse({ ...base, nights: 2, availability: [{ from: day(30), to: day(45) }] }));
  first.state.confirmConstraints(first.room, first.priya, ConstraintsSchema.parse({ ...base, nights: 2, availability: [{ from: day(40), to: day(50) }] }));
  await first.state.autopilot.planNow(first.room);
  assert.deepEqual(first.room.planning!.windows[0], { checkIn: day(40), checkOut: day(42) });

  const second = plannedState();
  second.state.confirmConstraints(second.room, second.alex, ConstraintsSchema.parse({ ...base, nights: 5, availability: [{ from: day(30), to: day(40) }] }));
  second.state.confirmConstraints(second.room, second.priya, ConstraintsSchema.parse({ ...base, nights: 5, availability: [{ from: day(36), to: day(50) }] }));
  await second.state.autopilot.planNow(second.room);
  assert.deepEqual(second.room.planning!.windows, [{ checkIn: day(36), checkOut: day(40) }]);
  assert.ok(second.room.events.some(event => event.title.includes("Most people wanted 5 nights, but no 5-night stretch fits everyone’s dates.")));
  assert.ok(!second.priya.inbox?.some(entry => entry.kind === "NUDGE"), "nobody is asked to move when a shorter trip works");
});

test("a single workable trip is chosen without a vote, and the host can reopen planning", async () => {
  const { state, room, alex, priya } = plannedState(async () => [{ name: "Asheville, NC", timeZone: "America/New_York", styles: ["MOUNTAINS"], why: "Mountains." }]);
  state.confirmConstraints(room, alex, ConstraintsSchema.parse({ ...base, tripStyles: ["MOUNTAINS"] }));
  state.confirmConstraints(room, priya, ConstraintsSchema.parse({ ...base, requiresFullCashRefund: true }));
  await state.autopilot.planNow(room);
  const view = state.roomDTO(room, alex.id);
  assert.equal(view.planning!.decidedBy, "ONLY_OPTION");
  assert.equal(view.trip!.destination, "Asheville, NC");
  const proposal = state.proposals.get(room.activeProposalId!)!;
  assert.equal(proposal.snapshot.offer.cancellationPolicyCode, "FULL_CASH_REFUND");
  assert.ok(room.search!.offerIds.every(id => id.startsWith("demo-asheville-nc-")));

  state.autopilot.planner.reopen(room);
  assert.equal(room.trip, undefined);
  assert.equal(proposal.state, "STALE");
  assert.equal(state.roomDTO(room, alex.id).planning!.stage, "PLANNING");
});

test("rehearsal stays are deterministic and cover the trip exactly", async () => {
  const { demoStays } = await import("../src/demo-stays.js");
  const trip = { destination: "Stowe, VT", countryCode: "US", checkIn: day(40), checkOut: day(43), guests: 4, timeZone: "America/New_York" };
  const first = demoStays(trip), again = demoStays(trip);
  assert.deepEqual(first.map(offer => [offer.offerId, offer.totalCents]), again.map(offer => [offer.offerId, offer.totalCents]));
  assert.equal(first.length, 3);
  for (const offer of first) {
    assert.equal(localDay(offer.checkInAt), trip.checkIn);
    assert.equal(localDay(offer.checkOutAt), trip.checkOut);
  }
  assert.ok(first[0]!.totalCents < first[2]!.totalCents);
});
