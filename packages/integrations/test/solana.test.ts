import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createSolanaRpc, generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { SolanaCommitments, verifyProposalWalletSignature } from "../src/solana.js";
const input = { roomPublicRef: "public-room", proposalId: "proposal", proposalVersion: 4, proposalHash: "a".repeat(64), eventType: "PROPOSAL_CREATED" as const };
const noop = async () => {};
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
function fakeRpc(confirmation: "confirmed" | "processed" | "error" | "throw", genesis = DEVNET) {
  let sends = 0;
  const rpc = {
    getGenesisHash: () => ({ send: async () => genesis }),
    getBalance: () => ({ send: async () => ({ value: 1_000_000n }) }),
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n } }) }),
    sendTransaction: () => ({ send: async () => { sends++; if (confirmation === "throw") throw Error("unknown outcome"); } }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ err: confirmation === "error" ? {} : null, confirmationStatus: confirmation }] }) }),
  };
  return { rpc: rpc as unknown as ReturnType<typeof createSolanaRpc>, sends: () => sends };
}
test("Solana missing signer is unavailable without a made-up transaction", async () => {
  assert.deepEqual(await new SolanaCommitments().record(input, noop), { status: "FAILED", code: "NOT_CONFIGURED" });
});
test("Solana signs the backend hash unchanged, persists before sending and requires actual confirmation", async () => {
  const mock = fakeRpc("confirmed"), signer = await generateKeyPairSigner();
  let pendingSignature = "";
  const result = await new SolanaCommitments(signer, mock.rpc).record(input, async pending => {
    assert.equal(mock.sends(), 0); pendingSignature = pending.transactionSignature;
    assert.ok(Buffer.from(pending.wireTransaction, "base64").includes(Buffer.from(input.proposalHash)));
  });
  assert.equal(result.status, "CONFIRMED"); assert.equal(result.transactionSignature, pendingSignature);
  assert.match(result.explorerUrl!, /cluster=devnet$/);
});
test("Solana group approval memo anchors both the backend proposal hash and verified signature bundle hash", async () => {
  const mock = fakeRpc("confirmed"), signer = await generateKeyPairSigner();
  const bundleHash = "b".repeat(64);
  const result = await new SolanaCommitments(signer, mock.rpc).record({ ...input, eventType: "GROUP_APPROVED", approvalBundleHash: bundleHash }, async pending => {
    assert.ok(Buffer.from(pending.wireTransaction, "base64").includes(Buffer.from(input.proposalHash)));
    assert.ok(Buffer.from(pending.wireTransaction, "base64").includes(Buffer.from(bundleHash)));
  });
  assert.equal(result.status, "CONFIRMED");
  assert.equal((await new SolanaCommitments(signer, mock.rpc).record({ ...input, eventType: "GROUP_APPROVED" }, noop)).status, "FAILED");
});
test("member wallet signature verifies only for the exact proposal ID, version and backend hash", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = getBase58Decoder().decode(new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32)));
  const message = `Accord approval\nproposalId=${input.proposalId}\nversion=${input.proposalVersion}\nproposalHash=${input.proposalHash}`;
  const signatureBase64 = sign(null, Buffer.from(message), keys.privateKey).toString("base64");
  const attestation = { publicKey, signatureBase64, proposalId: input.proposalId, version: input.proposalVersion, proposalHash: input.proposalHash };
  assert.equal(await verifyProposalWalletSignature(attestation), true);
  assert.equal(await verifyProposalWalletSignature({ ...attestation, proposalHash: "c".repeat(64) }), false);
  assert.equal(await verifyProposalWalletSignature({ ...attestation, version: 5 }), false);
});
for (const status of ["processed", "error", "throw"] as const) test(`Solana ${status} never yields a confirmed explorer link`, async () => {
  const mock = fakeRpc(status);
  const result = await new SolanaCommitments(await generateKeyPairSigner(), mock.rpc).record(input, noop);
  assert.notEqual(result.status, "CONFIRMED"); assert.equal(result.explorerUrl, undefined);
  assert.ok(result.transactionSignature);
});
test("Solana rejects mainnet and private fields without broadcasting", async () => {
  const mock = fakeRpc("confirmed", "mainnet");
  const adapter = new SolanaCommitments(await generateKeyPairSigner(), mock.rpc);
  assert.equal((await adapter.record(input, noop)).code, "DEVNET_REQUIRED");
  assert.equal(mock.sends(), 0);
  assert.equal((await adapter.record({ ...input, privateCap: 35000 } as typeof input, noop)).status, "FAILED");
});
test("Solana persistence failure prevents broadcast", async () => {
  const mock = fakeRpc("confirmed");
  const result = await new SolanaCommitments(await generateKeyPairSigner(), mock.rpc).record(input, async () => { throw Error("db unavailable"); });
  assert.equal(result.status, "FAILED"); assert.equal(mock.sends(), 0);
});
