import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createSolanaRpc } from "@solana/kit";
import { createApi } from "../packages/server/src/server.ts";
import { configuredSolana } from "../packages/server/src/solana-config.ts";

const solana = await configuredSolana();
if (!solana) {
  process.stderr.write("SOLANA_NOT_CONFIGURED: set a devnet operator seed in the gitignored root .env.\n");
  process.exit(1);
}
const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com");
const app = createApi({ solana, geminiApiKey: "", geminiModel: "", liteApiKey: "", serpApiKey: "" });
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
const base = `http://127.0.0.1:${app.server.address().port}/api`;
const proof = { observedAt: new Date().toISOString(), network: "devnet", operatorAddress: solana.operatorAddress,
  proposalOne: {}, proposalTwo: {}, differentHashes: false, verified: false };

async function call(path, method = "GET", body, cookie) {
  const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function settled(proposalId, cookie) {
  let view;
  for (let i = 0; i < 30; i++) {
    view = await call(`/proposals/${proposalId}/public`, "GET", undefined, cookie);
    if (view.status !== 200) throw new Error(`PROPOSAL_VIEW_${view.status}`);
    if (view.data.proposal.solana.status !== "PENDING") return view.data.proposal;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return view.data.proposal;
}
try {
  proof.devnetAvailable = await solana.devnetAvailable();
  const balance = await rpc.getBalance(solana.operatorAddress).send({ abortSignal: AbortSignal.timeout(10_000) });
  proof.operatorBalanceLamports = Number(balance.value);
  const health = await call("/health");
  if (health.status !== 200) throw new Error(`HEALTH_${health.status}`);
  proof.healthSolana = health.data.solana;
  const created = await call("/rooms", "POST", { name: "Devnet audit verification", goal: "A shared demo stay", displayName: "Synthetic member" });
  if (created.status !== 201) throw new Error(`CREATE_ROOM_${created.status}`);
  const room = `/rooms/${created.data.roomId}`;
  const cookie = created.cookie;
  const confirmed = await call(`${room}/me/constraints`, "POST", {
    maxContributionCents: 1_000_000, requiresFullCashRefund: false, requiresStepFreeAccess: false,
    softPreference: "", confirmed: true,
  }, cookie);
  if (confirmed.status !== 200) throw new Error(`CONSTRAINTS_${confirmed.status}`);
  const first = await call(`${room}/solve`, "POST", {}, cookie);
  if (first.status !== 200) throw new Error(`FIRST_SOLVE_${first.status}_${first.data.code ?? ""}`);
  const firstView = await settled(first.data.proposal.proposalId, cookie);
  proof.proposalOne = { version: firstView.version, hash: firstView.proposalHash,
    commitmentStatus: firstView.solana.status,
    ...(firstView.solana.status === "CONFIRMED" ? { transactionSignature: firstView.solana.transactionSignature, explorerUrl: firstView.solana.explorerUrl } : {}) };
  const changed = await call("/merchant/events", "POST", { offerId: firstView.offer.offerId,
    expectedOfferVersion: firstView.offer.offerVersion,
    mutation: { type: "INCREASE_PRICE", newTotalCents: firstView.offer.totalCents + 5_000 } }, cookie);
  if (changed.status !== 200) throw new Error(`MUTATION_${changed.status}_${changed.data.code ?? ""}`);
  const second = await call(`${room}/solve`, "POST", { replan: true }, cookie);
  if (second.status !== 200) throw new Error(`SECOND_SOLVE_${second.status}_${second.data.code ?? ""}`);
  const secondView = await settled(second.data.proposal.proposalId, cookie);
  proof.proposalTwo = { version: secondView.version, hash: secondView.proposalHash,
    commitmentStatus: secondView.solana.status,
    ...(secondView.solana.status === "CONFIRMED" ? { transactionSignature: secondView.solana.transactionSignature, explorerUrl: secondView.solana.explorerUrl } : {}) };
  proof.differentHashes = firstView.proposalHash !== secondView.proposalHash;
  proof.verified = proof.devnetAvailable && proof.differentHashes && proof.proposalOne.commitmentStatus === "CONFIRMED"
    && proof.proposalTwo.commitmentStatus === "CONFIRMED";
  if (!proof.verified) process.exitCode = 1;
} catch (error) {
  proof.error = String(error?.message ?? error).slice(0, 200);
  process.exitCode = 1;
} finally {
  app.state.streams.close();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  if (process.argv.includes("--record")) {
    await mkdir("sponsor-evidence", { recursive: true });
    await writeFile("sponsor-evidence/solana-devnet-smoke.json", JSON.stringify(proof, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(proof) + "\n");
}
