import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "@solana/keys";
import { getAddressFromPublicKey } from "@solana/addresses";
import { fixDecoderSize } from "@solana/codecs-core";
import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { SolanaCommitments, signerFromSecret } from "../src/solana.js";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const input = { roomPublicRef: "room1", proposalId: "prop1", proposalVersion: 1, proposalHash: "a".repeat(64), eventType: "PROPOSAL_CREATED" as const };

function fakeRpc(overrides: Partial<{ genesisHash: string; sendTransaction: () => Promise<unknown>; signatureStatus: { err: unknown; confirmationStatus?: string } }> = {}) {
  return {
    getGenesisHash: () => ({ send: async () => overrides.genesisHash ?? DEVNET_GENESIS_HASH }),
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n } }) }),
    sendTransaction: () => ({ send: overrides.sendTransaction ?? (async () => "sent") }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [overrides.signatureStatus ?? { err: null, confirmationStatus: "confirmed" }] }) }),
  };
}

test("no operator signer configured fails closed without any network call", async () => {
  const commitments = new SolanaCommitments(undefined, fakeRpc() as any);
  const result = await commitments.record(input, async () => { throw new Error("must not persist a pending commitment when unconfigured"); });
  assert.deepEqual(result, { status: "FAILED", code: "NOT_CONFIGURED" });
});

test("records and confirms a devnet commitment of the proposal hash, persisting the pending signature before broadcast", async () => {
  const signer = await generateKeyPairSigner();
  const commitments = new SolanaCommitments(signer, fakeRpc() as any);
  let persisted: { transactionSignature: string } | undefined;
  const result = await commitments.record(input, async pending => { persisted = pending; });
  assert.equal(result.status, "CONFIRMED");
  assert.ok(result.transactionSignature);
  assert.ok(result.explorerUrl?.includes(result.transactionSignature!));
  assert.ok(result.explorerUrl?.includes("cluster=devnet"));
  assert.equal(persisted?.transactionSignature, result.transactionSignature);
});

test("refuses to operate against a non-devnet RPC, protecting against a misconfigured mainnet endpoint", async () => {
  const signer = await generateKeyPairSigner();
  const commitments = new SolanaCommitments(signer, fakeRpc({ genesisHash: "not-devnet" }) as any);
  const result = await commitments.record(input, async () => {});
  assert.deepEqual(result, { status: "FAILED", code: "DEVNET_REQUIRED" });
});

test("a transaction that fails on-chain reconciles to FAILED, never CONFIRMED", async () => {
  const signer = await generateKeyPairSigner();
  const commitments = new SolanaCommitments(signer, fakeRpc({ signatureStatus: { err: { InstructionError: [0, "GenericError"] } } }) as any);
  const result = await commitments.record(input, async () => {});
  assert.equal(result.status, "FAILED");
  assert.equal(result.code, "TRANSACTION_FAILED");
});

test("signerFromSecret accepts a base58 secret key and a JSON byte array, matching the same address either way", async () => {
  const keyPair = await generateKeyPair(true);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const seed = Buffer.from(jwk.d!, "base64url");
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const secret64 = new Uint8Array(64);
  secret64.set(seed, 0); secret64.set(publicKeyBytes, 32);
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  const base58Secret = fixDecoderSize(getBase58Decoder(), 64).decode(secret64);

  const fromBase58 = await signerFromSecret(base58Secret);
  assert.equal(fromBase58.address, address);
  const fromJsonArray = await signerFromSecret(JSON.stringify(Array.from(secret64)));
  assert.equal(fromJsonArray.address, address);
});

test("signerFromSecret rejects malformed input instead of silently producing a wrong signer", async () => {
  await assert.rejects(() => signerFromSecret("not-valid-base58-!!!"));
  await assert.rejects(() => signerFromSecret(JSON.stringify([1, 2, 3])));
});
