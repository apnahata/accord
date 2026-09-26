import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";
import type { SolanaCommitments, CommitmentInput } from "../../integrations/src/solana.js";

test("operator commitments follow the backend hash through create, stale, replan, and booking", async t => {
  const recorded: CommitmentInput[] = [];
  const solana = {
    record: async (input: CommitmentInput, persist: (pending: { transactionSignature: string; wireTransaction: string; lastValidBlockHeight: string }) => Promise<void>) => {
      recorded.push(input);
      const signature = "A".repeat(63) + String(recorded.length);
      await persist({ transactionSignature: signature, wireTransaction: "signed-wire", lastValidBlockHeight: "100" });
      return { status: "CONFIRMED" as const, transactionSignature: signature,
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
    },
    reconcile: async () => { throw new Error("Unexpected reconciliation"); },
    resumeSigned: async () => { throw new Error("Unexpected signed-transaction resume"); },
  } as unknown as SolanaCommitments;
  const app = createApi({ solana, geminiApiKey: "", geminiModel: "" });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const call = async (path: string, method = "GET", body?: unknown, cookie?: string, key?: string) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), "commitment did not finish");
  };
  const created = await call("/rooms", "POST", { name: "Audit room", goal: "Shared stay", displayName: "Host" });
  assert.equal(created.status, 201);
  const joined = await call(`/invites/${created.data.inviteToken}/join`, "POST", { displayName: "Friend" });
  assert.equal(joined.status, 201);
  const cookies = [created.cookie!, joined.cookie!];
  for (const cookie of cookies) {
    const confirmed = await call(`/rooms/${created.data.roomId}/me/constraints`, "POST", {
      maxContributionCents: 1_000_000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", confirmed: true,
    }, cookie);
    assert.equal(confirmed.status, 200);
  }
  const first = await call(`/rooms/${created.data.roomId}/solve`, "POST", {}, cookies[0]);
  assert.equal(first.status, 200);
  assert.equal(first.data.proposal.solana.status, "PENDING");
  await waitFor(() => recorded.length >= 1);
  const firstView = await call(`/proposals/${first.data.proposal.proposalId}/public`, "GET", undefined, cookies[0]);
  assert.equal(firstView.data.proposal.solana.status, "CONFIRMED");
  assert.match(firstView.data.proposal.solana.explorerUrl, /cluster=devnet$/);
  assert.equal(recorded[0]!.proposalHash, first.data.proposal.proposalHash);
  assert.deepEqual(Object.keys(recorded[0]!).sort(), ["eventType", "proposalHash", "proposalId", "proposalVersion", "roomPublicRef"].sort());

  const changed = await call("/merchant/events", "POST", {
    offerId: first.data.proposal.offer.offerId, expectedOfferVersion: first.data.proposal.offer.offerVersion,
    mutation: { type: "INCREASE_PRICE", newTotalCents: first.data.proposal.offer.totalCents + 5_000 },
  }, cookies[0]);
  assert.equal(changed.status, 200);
  await waitFor(() => recorded.some(item => item.eventType === "PROPOSAL_STALE"));
  const second = await call(`/rooms/${created.data.roomId}/solve`, "POST", { replan: true }, cookies[0]);
  assert.equal(second.status, 200);
  assert.notEqual(second.data.proposal.proposalHash, first.data.proposal.proposalHash);
  await waitFor(() => recorded.filter(item => item.eventType === "PROPOSAL_CREATED").length === 2);
  for (let index = 0; index < cookies.length; index++) {
    const mine = await call(`/proposals/${second.data.proposal.proposalId}/me`, "GET", undefined, cookies[index]);
    assert.equal(mine.status, 200);
    const consent = await call(`/proposals/${second.data.proposal.proposalId}/consent`, "POST", {
      proposalHash: second.data.proposal.proposalHash, version: second.data.proposal.version,
      amountCents: mine.data.myContributionCents,
    }, cookies[index], `audit-consent-${index}`);
    assert.equal(consent.status, 200);
  }
  const booked = await call(`/proposals/${second.data.proposal.proposalId}/execute`, "POST", {
    proposalHash: second.data.proposal.proposalHash,
  }, cookies[0], "audit-booking");
  assert.equal(booked.status, 200);
  await waitFor(() => recorded.some(item => item.eventType === "BOOKING_CONFIRMED"));
  assert.equal(recorded.find(item => item.eventType === "BOOKING_CONFIRMED")?.proposalHash, second.data.proposal.proposalHash);
});
