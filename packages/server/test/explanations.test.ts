import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";

const modelResponse = (value: unknown) => new Response(JSON.stringify({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
}), { headers: { "content-type": "application/json" } });

test("Gemini selects public facts without private capsules and private checks for only the signed-in member", async t => {
  const prompts: string[] = [];
  const app = createApi({ geminiApiKey: "test-only", geminiModel: "test-model", geminiFetch: async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    prompts.push(prompt);
    return modelResponse(prompt.includes("ownConstraints")
      ? { selectedCheckKinds: ["BUDGET", "REFUND"] }
      : { reasonIds: ["requirements", "price"], tradeoffIds: [] });
  } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  async function call(path: string, method = "GET", body?: unknown, cookie?: string) {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Shared Miami stay", displayName: "Alex" });
  const room = `/rooms/${created.data.roomId}`, alex = created.cookie!;
  const joined = await call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName: "Jordan" });
  const jordan = joined.cookie!;
  for (const [cookie, maxContributionCents] of [[alex, 98765], [jordan, 87654]] as const) {
    assert.equal((await call(room + "/me/constraints", "POST", { maxContributionCents, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "walkable", confirmed: true }, cookie)).status, 200);
  }
  const offers = (await call(room + "/offers", "GET", undefined, alex)).data;
  const recommended = offers.offers.find((offer: any) => offer.offerId === offers.recommendedOfferId);
  const publicResult = await call(room + "/offers/explanation", "POST", { recommendedOfferId: recommended.offerId, offerVersion: recommended.offerVersion }, jordan);
  assert.equal(publicResult.status, 200);
  assert.equal(publicResult.data.source, "GEMINI");
  assert.match(publicResult.data.reasons.join(" "), /confirmed group requirement/);
  assert.ok(!prompts[0]!.includes("Alex"));
  assert.ok(!prompts[0]!.includes("Jordan"));
  assert.ok(!prompts[0]!.includes("98765"));
  assert.ok(!prompts[0]!.includes("87654"));
  assert.ok(!prompts[0]!.includes("ownConstraints"));

  const solved = await call(room + "/solve", "POST", {}, alex);
  assert.equal(solved.status, 200);
  const proposalId = solved.data.proposal.proposalId, proposalHash = solved.data.proposal.proposalHash;
  const privateResult = await call(`/proposals/${proposalId}/me/explanation`, "POST", { proposalHash }, alex);
  assert.equal(privateResult.status, 200);
  assert.equal(privateResult.data.source, "GEMINI");
  assert.match(privateResult.data.reasons.join(" "), /your confirmed maximum/i);
  assert.ok(prompts[1]!.includes("98765"));
  assert.ok(!prompts[1]!.includes("87654"));
  assert.ok(!prompts[1]!.includes("Jordan"));

  const outsider = await call("/rooms", "POST", { name: "Other", goal: "Stay", displayName: "Outsider" });
  const before = prompts.length;
  assert.equal((await call(`/proposals/${proposalId}/me/explanation`, "POST", { proposalHash }, outsider.cookie)).status, 403);
  assert.equal(prompts.length, before);
});

test("a merchant change during Gemini's public explanation discards the stale result", async t => {
  let changed = false;
  let offerId = "", offerVersion = "";
  const app = createApi({ geminiApiKey: "test-only", geminiModel: "test-model", geminiFetch: async () => {
    if (!changed) {
      changed = true;
      await app.state.mutate(offerId, offerVersion, { type: "ADD_MANDATORY_FEE", feeDeltaCents: 5000 });
    }
    return modelResponse({ reasonIds: ["requirements"], tradeoffIds: [] });
  } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const created = await fetch(base + "/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Trip", goal: "Stay", displayName: "Alex" }) });
  const { roomId } = await created.json() as any;
  const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { "content-type": "application/json", cookie };
  await fetch(`${base}/rooms/${roomId}/me/constraints`, { method: "POST", headers, body: JSON.stringify({ maxContributionCents: 200000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", confirmed: true }) });
  const offers = await (await fetch(`${base}/rooms/${roomId}/offers`, { headers })).json() as any;
  const recommended = offers.offers.find((offer: any) => offer.offerId === offers.recommendedOfferId);
  offerId = recommended.offerId; offerVersion = recommended.offerVersion;
  const response = await fetch(`${base}/rooms/${roomId}/offers/explanation`, { method: "POST", headers, body: JSON.stringify({ recommendedOfferId: offerId, offerVersion }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: "OFFER_CHANGED" });
  assert.equal(changed, true);
});

test("stale private explanations use each member's own changed-offer checks", async t => {
  const prompts: string[] = [];
  const app = createApi({ geminiApiKey: "test-only", geminiModel: "test-model", geminiFetch: async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    prompts.push(prompt);
    const own = JSON.parse(prompt);
    return modelResponse({ selectedCheckKinds: own.ownChecks.filter((check: any) => check.status !== "PASS").map((check: any) => check.kind) });
  } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  async function call(path: string, method = "GET", body?: unknown, cookie?: string) {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Stay", displayName: "Alex" });
  const room = `/rooms/${created.data.roomId}`, alex = created.cookie!;
  const others: string[] = [];
  for (const name of ["Jordan", "Priya", "Mateo"]) {
    const joined = await call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName: name });
    others.push(joined.cookie!);
  }
  for (const [index, cookie] of [alex, ...others].entries()) {
    const result = await call(room + "/me/constraints", "POST", { maxContributionCents: index === 0 ? 35000 : 90000,
      requiresFullCashRefund: index === 1, requiresStepFreeAccess: false, softPreference: "walkable", confirmed: true }, cookie);
    assert.equal(result.status, 200);
  }
  const solved = await call(room + "/solve", "POST", {}, alex);
  assert.equal(solved.status, 200);
  const proposalId = solved.data.proposal.proposalId, proposalHash = solved.data.proposal.proposalHash;
  const offerId = solved.data.proposal.offer.offerId;
  const price = await call("/merchant/events", "POST", { offerId, expectedOfferVersion: "v1", mutation: { type: "INCREASE_PRICE", newTotalCents: 144000 } }, alex);
  assert.equal(price.status, 200);
  const terms = await call("/merchant/events", "POST", { offerId, expectedOfferVersion: price.data.offerVersion, mutation: { type: "CHANGE_CANCELLATION", code: "TRAVEL_CREDIT" } }, alex);
  assert.equal(terms.status, 200);
  const url = `/proposals/${proposalId}/me/explanation`;
  const alexStory = await call(url, "POST", { proposalHash }, alex);
  assert.equal(alexStory.status, 200);
  assert.match(alexStory.data.reasons.join(" "), /\$360\.00 share exceeds your confirmed maximum of \$350\.00/);
  assert.match(alexStory.data.nextAction, /new proposal/);
  const jordanStory = await call(url, "POST", { proposalHash }, others[0]);
  assert.equal(jordanStory.status, 200);
  assert.match(jordanStory.data.reasons.join(" "), /no longer provides the full cash refund you required/);
  assert.ok(!prompts[1]!.includes("35000"));
  assert.ok(!jordanStory.data.reasons.join(" ").includes("$350"));
});
