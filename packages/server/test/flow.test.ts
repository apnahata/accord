import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";
import { AccordState, AppError } from "../src/state.js";

type Client = { cookie: string; roomId: string };

test("four private sessions recover from stale Miami consent and book Tampa once", async t => {
  const app = createApi();
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  async function call(path: string, method = "GET", body?: unknown, client?: Client, idempotencyKey?: string) {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(client ? { cookie: client.cookie } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() as any };
  }
  const created = await call("/rooms", "POST", { name: "Spring Break Stay", goal: "Shared stay", displayName: "Alex" });
  assert.equal(created.response.status, 201);
  const roomId = created.data.roomId, invite = created.data.inviteToken;
  const alex: Client = { cookie: created.response.headers.get("set-cookie")!.split(";")[0]!, roomId };
  const others: Record<string, Client> = {};
  for (const displayName of ["Priya", "Jordan", "Mateo"]) {
    const joined = await call(`/invites/${invite}/join`, "POST", { displayName });
    assert.equal(joined.response.status, 201);
    others[displayName] = { cookie: joined.response.headers.get("set-cookie")!.split(";")[0]!, roomId };
  }
  const clients = { Alex: alex, ...others };
  const limits: Record<string, any> = {
    Alex: { maxContributionCents: 35000, softPreference: "lowest reasonable price" },
    Priya: { maxContributionCents: 45000, latestCheckOutAt: "2027-03-14T16:00:00.000Z", softPreference: "walkable neighborhood" },
    Jordan: { maxContributionCents: 45000, requiresFullCashRefund: true, softPreference: "near activities" },
    Mateo: { maxContributionCents: 45000, requiresStepFreeAccess: true, softPreference: "quiet property" },
  };
  for (const [displayName, client] of Object.entries(clients)) {
    const confirmed = await call(`/rooms/${roomId}/me/constraints`, "POST", { ...limits[displayName], requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: limits[displayName].softPreference, ...limits[displayName], confirmed: true }, client);
    assert.equal(confirmed.response.status, 200);
  }
  const publicRoom = await call(`/rooms/${roomId}`, "GET", undefined, others.Priya);
  assert.equal(publicRoom.data.readyMemberCount, 4);
  assert.ok(!JSON.stringify(publicRoom.data).includes("35000"));
  const anonymous = await call(`/rooms/${roomId}`);
  assert.equal(anonymous.response.status, 401);
  const priyaPrivate = await call(`/rooms/${roomId}/me/constraints`, "GET", undefined, others.Priya);
  assert.equal(priyaPrivate.data.constraints.maxContributionCents, 45000);
  assert.ok(!JSON.stringify(priyaPrivate.data).includes("35000"));
  const original = await call(`/rooms/${roomId}/solve`, "POST", {}, alex);
  assert.equal(original.response.status, 200);
  assert.equal(original.data.proposal.offer.offerId, "miami-ocean-walk");
  assert.equal(original.data.proposal.equalShareCents, 30000);
  const oldId = original.data.proposal.proposalId, oldHash = original.data.proposal.proposalHash;
  for (const [displayName, client] of Object.entries(clients)) {
    const personal = await call(`/proposals/${oldId}/me`, "GET", undefined, client);
    assert.equal(personal.data.myContributionCents, 30000);
    const consent = await call(`/proposals/${oldId}/consent`, "POST", { proposalHash: oldHash, version: 1, amountCents: 30000 }, client, `consent-${displayName}-v1`);
    assert.equal(consent.response.status, 200);
  }
  const ready = await call(`/proposals/${oldId}/public`, "GET", undefined, alex);
  assert.equal(ready.data.proposal.authorization.authorizedCount, 4);
  const mutation = await call("/merchant/events", "POST", { offerId: "miami-ocean-walk", expectedOfferVersion: "v1", mutation: { type: "INCREASE_PRICE", newTotalCents: 144000 } }, alex);
  assert.equal(mutation.response.status, 200);
  assert.equal(mutation.data.offerVersion, "v2");
  const stale = await call(`/proposals/${oldId}/public`, "GET", undefined, alex);
  assert.equal(stale.data.proposal.state, "STALE");
  assert.equal(stale.data.proposal.authorization.authorizedCount, 0);
  const blocked = await call(`/proposals/${oldId}/execute`, "POST", { proposalHash: oldHash }, alex, `booking-${oldHash}`);
  assert.equal(blocked.response.status, 409);
  const alexPrivate = await call(`/proposals/${oldId}/me`, "GET", undefined, alex);
  assert.equal(alexPrivate.data.myConstraintChecks.find((item: any) => item.kind === "BUDGET").status, "FAIL");
  assert.ok(!JSON.stringify(stale.data).includes("35000"));
  const worseTerms = await call("/merchant/events", "POST", { offerId: "miami-ocean-walk", expectedOfferVersion: "v2", mutation: { type: "CHANGE_CANCELLATION", code: "TRAVEL_CREDIT" } }, alex);
  assert.equal(worseTerms.response.status, 200);
  const jordanPrivate = await call(`/proposals/${oldId}/me`, "GET", undefined, others.Jordan);
  assert.equal(jordanPrivate.data.myConstraintChecks.find((item: any) => item.kind === "REFUND").status, "FAIL");
  const replanned = await call(`/rooms/${roomId}/solve`, "POST", { replan: true }, alex);
  assert.equal(replanned.response.status, 200);
  assert.equal(replanned.data.proposal.offer.offerId, "tampa-river-court");
  assert.equal(replanned.data.proposal.equalShareCents, 28000);
  assert.notEqual(replanned.data.proposal.proposalHash, oldHash);
  const newId = replanned.data.proposal.proposalId, newHash = replanned.data.proposal.proposalHash;
  const premature = await call(`/proposals/${newId}/execute`, "POST", { proposalHash: newHash }, alex, `booking-${newHash}`);
  assert.equal(premature.response.status, 409);
  for (const [displayName, client] of Object.entries(clients)) {
    const consent = await call(`/proposals/${newId}/consent`, "POST", { proposalHash: newHash, version: 2, amountCents: 28000 }, client, `consent-${displayName}-v2`);
    assert.equal(consent.response.status, 200);
  }
  const booked = await call(`/proposals/${newId}/execute`, "POST", { proposalHash: newHash }, alex, `booking-${newHash}`);
  assert.equal(booked.response.status, 200);
  assert.equal(booked.data.status, "CONFIRMED");
  assert.match(booked.data.providerModeLabel, /SIMULATED/);
  const retry = await call(`/proposals/${newId}/execute`, "POST", { proposalHash: newHash }, alex, `booking-${newHash}`);
  assert.equal(retry.data.bookingReference, booked.data.bookingReference);
  const receipt = await call(`/rooms/${roomId}/receipt`, "GET", undefined, others.Jordan);
  assert.equal(receipt.data.bookingReference, booked.data.bookingReference);
});

test("merchant mutations reject concurrent reuse of one expected offer version", async () => {
  const state = new AccordState();
  await state.ready;
  const results = await Promise.allSettled([
    state.mutate("miami-ocean-walk", "v1", { type: "INCREASE_PRICE", newTotalCents: 144000 }),
    state.mutate("miami-ocean-walk", "v1", { type: "INCREASE_PRICE", newTotalCents: 150000 }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejection = results.find(result => result.status === "rejected");
  assert.ok(rejection?.status === "rejected" && rejection.reason instanceof AppError);
  assert.equal(rejection.reason.code, "OFFER_VERSION_MISMATCH");
  assert.equal((await state.currentOffer("miami-ocean-walk"))?.offerVersion, "v2");
});
