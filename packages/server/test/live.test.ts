import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";
import { localToInstant } from "../src/stays.js";

// Provider responses are controlled here; the live APIs are exercised manually, not in CI.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const monthDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const trip = { destination: "Testville, FL", checkIn: day(60), checkOut: day(64), guests: 3 };

function providers(options: { hotelStepFree?: boolean } = {}) {
  const calls = { serp: 0, book: 0 };
  const state = { refundableCents: 90000 };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const rate = (name: string, tag: string, amount: number, offerId: string) => ({ offerId, rates: [{ name, maxOccupancy: 4, retailRate: { total: [{ amount, currency: "USD" }] },
    cancellationPolicies: { refundableTag: tag, cancelPolicyInfos: tag === "RFN" ? [{ cancelTime: `${day(50)} 10:00:00` }] : [] } }] });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/hotels/rates")) return json({ data: [{ hotelId: "H1", roomTypes: [rate("Double Room", "RFN", state.refundableCents / 100, "offer-rfn"), rate("Double Room", "NRFN", 800, "offer-nrfn")] }], hotels: [{ id: "H1", name: "Test Hotel" }] });
    if (url.includes("/data/hotel")) return json({ data: { name: "Test Hotel", city: "Testville", address: "1 Main St", rating: 8.8, reviewCount: 120,
      checkinCheckoutTimes: { checkin_start: "03:00 PM", checkout: "11:00 AM" }, hotelFacilities: options.hotelStepFree === false ? ["Pool"] : ["Wheelchair accessible"],
      poi: [{ name: "Beach", distanceKm: 0.5, importance: "major" }], sentiment_analysis: { pros: ["Great location"], cons: ["Small rooms"], categories: [{ name: "Location", rating: 9.5 }] } } });
    if (url.includes("/rates/prebook")) return json({ data: { prebookId: "PB1", price: state.refundableCents / 100, currency: "USD", cancellationChanged: false } });
    if (url.includes("/rates/book")) { calls.book++; assert.equal(JSON.parse(String(init?.body)).payment.method, "ACC_CREDIT_CARD"); return json({ data: { bookingId: "BK1", status: "CONFIRMED", price: state.refundableCents / 100 } }); }
    if (url.includes("serpapi.com")) { calls.serp++; return json({ properties: [{ type: "vacation rental", property_token: "tok1", name: "Beach House", link: "https://example.com/beach-house",
      total_rate: { extracted_lowest: 1000 }, essential_info: ["Entire house", "Sleeps 6", "3 bedrooms"], check_in_time: "4:00 PM", check_out_time: "10:00 AM",
      prices: [{ source: "ExampleStays", free_cancellation: true, free_cancellation_until_date: monthDay(40), free_cancellation_until_time: "11:59 PM" }],
      amenities: ["Wheelchair accessible", "Pool"], excluded_amenities: [], nearby_places: [{ name: "Pier", transportations: [{ type: "Walking", duration: "5 min" }] }], overall_rating: 4.8, reviews: 40 }] }); }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  return { fetcher, calls, state };
}

async function start(fetcher: typeof fetch) {
  const app = createApi({ liteApiKey: "test", serpApiKey: "test", staysFetch: fetcher, geminiApiKey: "", geminiModel: "" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const call = async (path: string, method = "GET", body?: unknown, cookie?: string, key?: string) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const stop = async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); };
  return { call, stop };
}

async function group(call: Awaited<ReturnType<typeof start>>["call"], limits: Record<string, Partial<{ maxContributionCents: number; requiresFullCashRefund: boolean; requiresStepFreeAccess: boolean }>>) {
  const [host, ...others] = Object.keys(limits);
  const created = await call("/rooms", "POST", { name: "Trip", displayName: host, trip });
  assert.equal(created.status, 201);
  const cookies: Record<string, string> = { [host!]: created.cookie! };
  for (const name of others) cookies[name] = (await call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName: name })).cookie!;
  for (const [name, limit] of Object.entries(limits)) {
    const confirmed = await call(`/rooms/${created.data.roomId}/me/constraints`, "POST", { maxContributionCents: 51234, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", ...limit, confirmed: true }, cookies[name]);
    assert.equal(confirmed.status, 200);
  }
  return { roomId: created.data.roomId as string, cookies };
}

async function consentAll(call: Awaited<ReturnType<typeof start>>["call"], proposal: any, cookies: Record<string, string>) {
  for (const [name, cookie] of Object.entries(cookies)) {
    const mine = (await call(`/proposals/${proposal.proposalId}/me`, "GET", undefined, cookie)).data;
    assert.equal((await call(`/proposals/${proposal.proposalId}/consent`, "POST", { proposalHash: proposal.proposalHash, version: proposal.version, amountCents: mine.myContributionCents }, cookie, `c-${name}-${proposal.version}`)).status, 200);
  }
}

test("converts destination wall-clock times to instants", () => {
  assert.equal(localToInstant("2026-11-16", "11:00 AM", "America/New_York"), "2026-11-16T16:00:00.000Z");
  assert.equal(localToInstant("2026-07-16", "12:00 PM", "America/New_York"), "2026-07-16T16:00:00.000Z");
  assert.equal(localToInstant("2026-07-16", "12:00 AM", "America/New_York"), "2026-07-16T04:00:00.000Z");
});

test("live search: real-provider offers are checked privately and booked through the LiteAPI sandbox", async t => {
  const mock = providers();
  const { call, stop } = await start(mock.fetcher);
  t.after(stop);
  const { roomId, cookies } = await group(call, { Alex: {}, Jordan: { requiresFullCashRefund: true } });
  const solved = await call(`/rooms/${roomId}/solve`, "POST", {}, cookies.Alex);
  assert.equal(solved.status, 200);
  assert.equal(solved.data.proposal.offer.propertyName, "Test Hotel");
  assert.equal(solved.data.proposal.offer.cancellationLabel, "Full cash refund");
  assert.equal(solved.data.proposal.offer.source, "LITEAPI");
  const offers = (await call(`/rooms/${roomId}/offers`, "GET", undefined, cookies.Alex)).data;
  assert.equal(offers.offers.length, 3);
  assert.equal(offers.offers.find((o: any) => o.cancellationLabel === "Non-refundable").feasible, false);
  const rental = offers.offers.find((o: any) => o.source === "GOOGLE_HOTELS");
  assert.equal(rental.feasible, true);
  assert.equal(rental.externalUrl, "https://example.com/beach-house");
  assert.deepEqual(offers.offers.find((o: any) => o.offerId === offers.recommendedOfferId).research.pros, ["Great location"]);
  assert.ok(!JSON.stringify(offers).includes("51234"));

  await consentAll(call, solved.data.proposal, cookies);
  const booked = await call(`/proposals/${solved.data.proposal.proposalId}/execute`, "POST", { proposalHash: solved.data.proposal.proposalHash }, cookies.Alex, "book-1");
  assert.equal(booked.status, 200);
  assert.equal(booked.data.status, "CONFIRMED");
  assert.equal(booked.data.bookingReference, "BK1");
  assert.match(booked.data.providerModeLabel, /SANDBOX/);
  const retry = await call(`/proposals/${solved.data.proposal.proposalId}/execute`, "POST", { proposalHash: solved.data.proposal.proposalHash }, cookies.Alex, "book-1");
  assert.equal(retry.data.bookingReference, "BK1");
  assert.equal(mock.calls.book, 1);
});

test("live search: a price change found at booking time stales consent instead of booking", async t => {
  const mock = providers();
  const { call, stop } = await start(mock.fetcher);
  t.after(stop);
  const { roomId, cookies } = await group(call, { Alex: {}, Jordan: { requiresFullCashRefund: true } });
  const proposal = (await call(`/rooms/${roomId}/solve`, "POST", {}, cookies.Alex)).data.proposal;
  await consentAll(call, proposal, cookies);
  mock.state.refundableCents = 96000;
  const blocked = await call(`/proposals/${proposal.proposalId}/execute`, "POST", { proposalHash: proposal.proposalHash }, cookies.Alex, "book-2");
  assert.equal(blocked.data.code, "PROPOSAL_STALE");
  assert.equal(mock.calls.book, 0);
  const view = (await call(`/proposals/${proposal.proposalId}/public`, "GET", undefined, cookies.Jordan)).data;
  assert.equal(view.proposal.state, "STALE");
  assert.deepEqual(view.changes.find((c: any) => c.label === "Total price"), { label: "Total price", before: "$900.00", after: "$960.00" });
  const replanned = await call(`/rooms/${roomId}/solve`, "POST", { replan: true }, cookies.Alex);
  assert.equal(replanned.data.proposal.offer.totalCents, 96000);
  assert.equal(mock.calls.serp, 1, "vacation-rental results are cached between searches");
});

test("a member leaving stales consent and each remaining member privately sees their new share", async t => {
  const mock = providers();
  const { call, stop } = await start(mock.fetcher);
  t.after(stop);
  const { roomId, cookies } = await group(call, { Alex: {}, Jordan: { maxContributionCents: 40000, requiresFullCashRefund: true }, Mateo: {} });
  const proposal = (await call(`/rooms/${roomId}/solve`, "POST", {}, cookies.Alex)).data.proposal;
  assert.equal(proposal.equalShareCents, 30000);
  await consentAll(call, proposal, cookies);
  assert.equal((await call(`/rooms/${roomId}/me/leave`, "POST", {}, cookies.Alex)).data.code, "HOST_CANNOT_LEAVE");
  const left = await call(`/rooms/${roomId}/me/leave`, "POST", {}, cookies.Mateo);
  assert.equal(left.status, 200);
  assert.equal((await call(`/rooms/${roomId}`, "GET", undefined, cookies.Mateo)).status, 401);
  const view = (await call(`/proposals/${proposal.proposalId}/public`, "GET", undefined, cookies.Alex)).data;
  assert.equal(view.proposal.state, "STALE");
  assert.equal(view.proposal.authorization.authorizedCount, 0);
  assert.deepEqual(view.changes.find((c: any) => c.label === "Equal share"), { label: "Equal share", before: "$300.00", after: "$450.00" });
  assert.ok(!JSON.stringify(view).includes("40000"));
  const jordan = (await call(`/proposals/${proposal.proposalId}/me`, "GET", undefined, cookies.Jordan)).data;
  assert.equal(jordan.myConstraintChecks.find((c: any) => c.kind === "BUDGET").status, "FAIL");
  const alex = (await call(`/proposals/${proposal.proposalId}/me`, "GET", undefined, cookies.Alex)).data;
  assert.equal(alex.myConstraintChecks.find((c: any) => c.kind === "BUDGET").status, "PASS");
});

test("an approved vacation rental hands off to the listing site instead of claiming a booking", async t => {
  const mock = providers({ hotelStepFree: false });
  const { call, stop } = await start(mock.fetcher);
  t.after(stop);
  const { roomId, cookies } = await group(call, { Alex: {}, Mateo: { requiresStepFreeAccess: true } });
  const proposal = (await call(`/rooms/${roomId}/solve`, "POST", {}, cookies.Alex)).data.proposal;
  assert.equal(proposal.offer.source, "GOOGLE_HOTELS");
  await consentAll(call, proposal, cookies);
  const receipt = await call(`/proposals/${proposal.proposalId}/execute`, "POST", { proposalHash: proposal.proposalHash }, cookies.Alex, "book-3");
  assert.equal(receipt.data.status, "HANDOFF");
  assert.equal(receipt.data.externalUrl, "https://example.com/beach-house");
  assert.equal(mock.calls.book, 0);
});
