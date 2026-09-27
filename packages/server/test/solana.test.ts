import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";
import type { SolanaCommitmentsPort, CommitmentInput, CommitmentResult } from "../../integrations/src/solana.js";

const fast = { readyDelayMs: 0, replanDelayMs: 0, watchIntervalMs: 0 };

async function waitFor<T>(read: () => Promise<T | undefined | false>, label: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fakeSolana(result: CommitmentResult = { status: "CONFIRMED", transactionSignature: "sig123", explorerUrl: "https://explorer.solana.com/tx/sig123?cluster=devnet" }): SolanaCommitmentsPort & { calls: CommitmentInput["eventType"][] } {
  return {
    calls: [],
    async record(input) { this.calls.push(input.eventType); return result; },
  };
}

async function start(t: test.TestContext, options: Parameters<typeof createApi>[0] = {}) {
  const app = createApi({ autopilot: fast, ...options });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const call = async (path: string, method = "GET", body?: unknown, cookie?: string, key?: string) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  return { call };
}

test("with no Solana signer configured, health and the proposal DTO both report the feature is off, and nothing is attempted", async t => {
  const { call } = await start(t);
  assert.equal((await call("/health")).data.solana, "UNCONFIGURED");
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Shared stay", displayName: "Alex" });
  const cookie = created.cookie!, roomId = created.data.roomId;
  await call(`/rooms/${roomId}/me/constraints`, "POST", { maxContributionCents: 200000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", confirmed: true }, cookie);
  const solved = await call(`/rooms/${roomId}/solve`, "POST", {}, cookie);
  assert.equal(solved.status, 200);
  const proposalId = solved.data.proposal.proposalId as string;
  const proposal = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookie)).data.proposal;
  assert.deepEqual(proposal.solana, { status: "NOT_RECORDED" });
});

test("with a Solana provider configured, health reports it and a devnet commitment for the new proposal appears in the public DTO", async t => {
  const solana = fakeSolana();
  const { call } = await start(t, { solana });
  assert.equal((await call("/health")).data.solana, "CONFIGURED");
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Shared stay", displayName: "Alex" });
  const cookie = created.cookie!, roomId = created.data.roomId;
  await call(`/rooms/${roomId}/me/constraints`, "POST", { maxContributionCents: 200000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", confirmed: true }, cookie);
  const solved = await call(`/rooms/${roomId}/solve`, "POST", {}, cookie);
  assert.equal(solved.status, 200);
  const proposalId = solved.data.proposal.proposalId as string;
  await waitFor(async () => solana.calls.includes("PROPOSAL_CREATED"), "the PROPOSAL_CREATED commitment attempt");
  const proposal = await waitFor(async () => {
    const view = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookie)).data.proposal;
    return view.solana.status === "CONFIRMED" ? view : undefined;
  }, "the confirmed commitment to appear in the public DTO");
  assert.equal(proposal.solana.transactionSignature, "sig123");
  assert.ok(proposal.solana.explorerUrl.includes("sig123"));
});

test("a merchant price change that stales the proposal also attempts a PROPOSAL_STALE commitment, and consent/booking never wait on it", async t => {
  const solana = fakeSolana();
  const { call } = await start(t, { solana });
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Shared stay", displayName: "Alex" });
  const cookie = created.cookie!, roomId = created.data.roomId;
  await call(`/rooms/${roomId}/me/constraints`, "POST", { maxContributionCents: 200000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", confirmed: true }, cookie);
  const solved = await call(`/rooms/${roomId}/solve`, "POST", {}, cookie);
  assert.equal(solved.status, 200);
  const proposalId = solved.data.proposal.proposalId as string;
  await waitFor(async () => solana.calls.includes("PROPOSAL_CREATED"), "the PROPOSAL_CREATED commitment attempt");
  const before = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookie)).data.proposal;
  const mutated = await call("/merchant/events", "POST", { offerId: before.offer.offerId, expectedOfferVersion: before.offer.offerVersion, mutation: { type: "INCREASE_PRICE", newTotalCents: before.offer.totalCents + 100000 } }, cookie);
  assert.equal(mutated.status, 200);
  const staled = await waitFor(async () => {
    const view = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookie)).data.proposal;
    return view.state === "STALE" ? view : undefined;
  }, "the proposal to go stale");
  assert.equal(staled.state, "STALE");
  await waitFor(async () => solana.calls.includes("PROPOSAL_STALE"), "the PROPOSAL_STALE commitment attempt");
});

test("a Solana provider that throws never breaks proposal creation (best-effort, fails closed)", async t => {
  const solana: SolanaCommitmentsPort = { record: async () => { throw new Error("devnet unreachable"); } };
  const { call } = await start(t, { solana });
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Shared stay", displayName: "Alex" });
  const cookie = created.cookie!, roomId = created.data.roomId;
  await call(`/rooms/${roomId}/me/constraints`, "POST", { maxContributionCents: 200000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", confirmed: true }, cookie);
  const solved = await call(`/rooms/${roomId}/solve`, "POST", {}, cookie);
  assert.equal(solved.status, 200);
  const proposalId = solved.data.proposal.proposalId as string;
  const proposal = (await call(`/proposals/${proposalId}/public`, "GET", undefined, cookie)).data.proposal;
  assert.equal(proposal.state, "OPEN");
});
