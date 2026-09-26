import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createApi } from "../packages/server/src/server.ts";

if (!process.env.LITEAPI_KEY || !process.env.SERPAPI_KEY) {
  process.stderr.write("LIVE_STAYS_NOT_CONFIGURED: set LITEAPI_KEY and SERPAPI_KEY in the gitignored root .env.\n");
  process.exit(1);
}
if (process.argv.includes("--record") && (process.argv.includes("--search-only") || process.argv.includes("--handoff-only"))) {
  process.stderr.write("RECORD_REQUIRES_FULL_FLOW: partial checks must not overwrite full-flow evidence.\n");
  process.exit(1);
}

const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const trip = { destination: "Miami, FL", checkIn: day(45), checkOut: day(49), guests: 4 };
const proof = { observedAt: new Date().toISOString(), scenario: "Four synthetic member sessions using real stay-provider APIs", trip,
  search: { status: "NOT_RUN" }, booking: { status: "NOT_RUN" }, handoff: { status: "NOT_RUN" } };

async function withApi(options, run) {
  const app = createApi({ ...options, geminiApiKey: "", geminiModel: "" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (path, method = "GET", body, cookie, idempotencyKey) => {
    const response = await fetch(base + path, { method, headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  try { return await run(call); }
  finally {
    app.state.streams.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  }
}

async function createGroup(call) {
  const names = ["Sandbox Host", "Sandbox Member Two", "Sandbox Member Three", "Sandbox Member Four"];
  const created = await call("/rooms", "POST", { name: "Live provider verification", displayName: names[0], trip });
  assert.equal(created.status, 201, `create room: ${created.data.code}`);
  const cookies = [created.cookie];
  for (const displayName of names.slice(1)) {
    const joined = await call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName });
    assert.equal(joined.status, 201, `join room: ${joined.data.code}`);
    cookies.push(joined.cookie);
  }
  for (const cookie of cookies) {
    const confirmed = await call(`/rooms/${created.data.roomId}/me/constraints`, "POST", {
      maxContributionCents: 1_000_000, requiresFullCashRefund: false, requiresStepFreeAccess: false,
      softPreference: "", confirmed: true,
    }, cookie);
    assert.equal(confirmed.status, 200, `confirm constraints: ${confirmed.data.code}`);
  }
  return { roomId: created.data.roomId, cookies };
}

async function consentAll(call, group, proposal) {
  for (let index = 0; index < group.cookies.length; index++) {
    const cookie = group.cookies[index];
    const own = await call(`/proposals/${proposal.proposalId}/me`, "GET", undefined, cookie);
    assert.equal(own.status, 200, `member view: ${own.data.code}`);
    const consent = await call(`/proposals/${proposal.proposalId}/consent`, "POST", {
      proposalHash: proposal.proposalHash, version: proposal.version,
      amountCents: own.data.myContributionCents,
    }, cookie, `live-consent-${index}-${randomUUID()}`);
    assert.equal(consent.status, 200, `member consent: ${consent.data.code}`);
  }
}

try {
  if (!process.argv.includes("--handoff-only")) await withApi({ liteApiKey: process.env.LITEAPI_KEY, serpApiKey: process.env.SERPAPI_KEY }, async call => {
    const group = await createGroup(call);
    const solved = await call(`/rooms/${group.roomId}/solve`, "POST", {}, group.cookies[0]);
    assert.equal(solved.status, 200, `combined solve: ${solved.data.code}`);
    const found = await call(`/rooms/${group.roomId}/offers`, "GET", undefined, group.cookies[0]);
    assert.equal(found.status, 200);
    const events = await call(`/rooms/${group.roomId}/events`, "GET", undefined, group.cookies[0]);
    proof.search = {
      status: "VERIFIED", httpStatus: solved.status,
      liteApiOffers: found.data.offers.filter(offer => offer.source === "LITEAPI").length,
      googleHotelsOffers: found.data.offers.filter(offer => offer.source === "GOOGLE_HOTELS").length,
      externalHandoffLinks: found.data.offers.filter(offer => offer.source === "GOOGLE_HOTELS" && offer.externalUrl).length,
      feasibleOffers: found.data.offers.filter(offer => offer.feasible).length,
      recommendedSource: solved.data.proposal.offer.source,
      providerEvents: events.data.events.filter(event => /^(LiteAPI|Google Hotels):/.test(event.title)).map(event => event.title),
    };
    assert.ok(proof.search.liteApiOffers > 0, "No LiteAPI offers reached Accord");
    assert.ok(proof.search.googleHotelsOffers > 0, "No Google Hotels offers reached Accord");
    assert.equal(proof.search.externalHandoffLinks, proof.search.googleHotelsOffers, "Rental without handoff link reached Accord");
  });

  // Use only LiteAPI in this separate room so the deterministic solver can
  // choose a hotel; Google Hotels rentals are search-only external handoffs.
  if (!process.argv.includes("--search-only") && !process.argv.includes("--handoff-only")) await withApi({ liteApiKey: process.env.LITEAPI_KEY, serpApiKey: "" }, async call => {
    const group = await createGroup(call);
    const solved = await call(`/rooms/${group.roomId}/solve`, "POST", {}, group.cookies[0]);
    assert.equal(solved.status, 200, `hotel solve: ${solved.data.code}`);
    const proposal = solved.data.proposal;
    assert.equal(proposal.offer.source, "LITEAPI");
    proof.booking = { status: "PROPOSAL_CREATED", offerName: proposal.offer.propertyName,
      totalCents: proposal.offer.totalCents, offerVersion: proposal.offer.offerVersion,
      proposalHash: proposal.proposalHash, authorizationMode: "SIMULATED" };
    await consentAll(call, group, proposal);
    proof.booking.status = "FOUR_SIMULATED_AUTHORIZATIONS";
    const key = `live-sandbox-${randomUUID()}`;
    const booked = await call(`/proposals/${proposal.proposalId}/execute`, "POST", { proposalHash: proposal.proposalHash }, group.cookies[0], key);
    if (booked.status !== 200) {
      proof.booking = { ...proof.booking, status: "BOOKING_FAILED", httpStatus: booked.status, errorCode: booked.data.code };
      throw new Error(`Sandbox booking returned ${booked.status} ${booked.data.code ?? "UNKNOWN"}`);
    }
    assert.equal(booked.data.status, "CONFIRMED");
    assert.match(booked.data.providerModeLabel, /SANDBOX/);
    const retry = await call(`/proposals/${proposal.proposalId}/execute`, "POST", { proposalHash: proposal.proposalHash }, group.cookies[0], key);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.bookingReference, booked.data.bookingReference);
    const lookup = await fetch(`https://book.liteapi.travel/v3.0/bookings/${encodeURIComponent(booked.data.bookingReference)}`, {
      headers: { "X-API-Key": process.env.LITEAPI_KEY, accept: "application/json" }, signal: AbortSignal.timeout(20_000),
    });
    const details = await lookup.json().catch(() => ({}));
    const booking = details.data ?? details;
    proof.booking.providerLookup = { httpStatus: lookup.status, bookingIdMatches: booking.bookingId === booked.data.bookingReference,
      status: booking.status, sandbox: booking.sandbox, priceCents: Math.round(Number(booking.price) * 100), currency: booking.currency };
    assert.equal(lookup.status, 200, "LiteAPI booking lookup failed");
    assert.equal(booking.bookingId, booked.data.bookingReference);
    assert.equal(booking.status, "CONFIRMED");
    assert.equal(booking.sandbox, 1);
    assert.equal(proof.booking.providerLookup.priceCents, proposal.offer.totalCents);
    proof.booking = { ...proof.booking, status: "VERIFIED", httpStatus: booked.status,
      bookingReference: booked.data.bookingReference, retryReturnedSameReference: true };
  });

  if (!process.argv.includes("--search-only")) await withApi({ liteApiKey: "", serpApiKey: process.env.SERPAPI_KEY }, async call => {
    const group = await createGroup(call);
    const solved = await call(`/rooms/${group.roomId}/solve`, "POST", {}, group.cookies[0]);
    assert.equal(solved.status, 200, `rental solve: ${solved.data.code}`);
    const proposal = solved.data.proposal;
    assert.equal(proposal.offer.source, "GOOGLE_HOTELS");
    const link = new URL(proposal.offer.externalUrl);
    assert.equal(link.protocol, "https:");
    await consentAll(call, group, proposal);
    const result = await call(`/proposals/${proposal.proposalId}/execute`, "POST", { proposalHash: proposal.proposalHash }, group.cookies[0], `rental-handoff-${randomUUID()}`);
    assert.equal(result.status, 200, `rental handoff: ${result.data.code}`);
    assert.equal(result.data.status, "HANDOFF");
    assert.equal(result.data.externalUrl, proposal.offer.externalUrl);
    proof.handoff = { status: "VERIFIED", httpStatus: result.status, receiptStatus: result.data.status,
      linkHost: link.host, authorizationMode: "SIMULATED", bookingOccurred: false };
  });
} catch (error) {
  proof.error = String(error?.message ?? error).slice(0, 300);
  process.exitCode = 1;
} finally {
  if (process.argv.includes("--record")) {
    await mkdir("sponsor-evidence", { recursive: true });
    await writeFile("sponsor-evidence/live-stays-smoke.json", JSON.stringify(proof, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(proof) + "\n");
}
