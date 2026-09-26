import test from "node:test";
import assert from "node:assert/strict";
import { getBase58Decoder } from "@solana/kit";
import { SolanaCommitments } from "../../integrations/src/solana.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1));

test("a stored signed transaction is rebroadcast once and linked only after confirmation", async () => {
  let lookups = 0;
  let broadcasts = 0;
  const rpc = {
    getGenesisHash: () => ({ send: async () => DEVNET_GENESIS }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [++lookups === 1 ? null : { confirmationStatus: "confirmed", err: null }] }) }),
    getBlockHeight: () => ({ send: async () => 10n }),
    sendTransaction: () => ({ send: async () => { broadcasts++; return signature; } }),
  };
  const adapter = new SolanaCommitments(undefined, rpc as never);
  const result = await adapter.resumeSigned(signature, "signed-wire", "20");
  assert.equal(broadcasts, 1);
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.explorerUrl, `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
});

test("an expired signed transaction fails without rebroadcast or explorer link", async () => {
  let broadcasts = 0;
  const rpc = {
    getGenesisHash: () => ({ send: async () => DEVNET_GENESIS }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
    getBlockHeight: () => ({ send: async () => 21n }),
    sendTransaction: () => ({ send: async () => { broadcasts++; return signature; } }),
  };
  const adapter = new SolanaCommitments(undefined, rpc as never);
  const result = await adapter.resumeSigned(signature, "signed-wire", "20");
  assert.equal(broadcasts, 0);
  assert.equal(result.status, "FAILED");
  assert.equal(result.code, "BLOCKHASH_EXPIRED");
  assert.equal(result.explorerUrl, undefined);
});
