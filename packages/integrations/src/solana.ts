import { address, appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase58Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signature as parseSignature, signTransactionMessageWithSigners } from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";
import { z } from "zod";

/** Accepts a base58 secret key (as printed by solana-keygen / most wallets) or a JSON array of 64 bytes. */
export async function signerFromSecret(secret: string): Promise<KeyPairSigner> {
  const trimmed = secret.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(trimmed)))
    : getBase58Encoder().encode(trimmed);
  if (bytes.length !== 64) throw new Error("SOLANA_SIGNER_SECRET_KEY must decode to a 64-byte secret key");
  return createKeyPairSignerFromBytes(bytes);
}

// An integration payload, built from the backend's existing hash; no hashing occurs here.
const commitment = z.strictObject({
  roomPublicRef: z.string().min(1).max(80), proposalId: z.string().min(1).max(80),
  proposalVersion: z.number().int().positive(), proposalHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  eventType: z.enum(["PROPOSAL_CREATED", "PROPOSAL_STALE", "BOOKING_CONFIRMED"]),
});
export type CommitmentInput = z.infer<typeof commitment>;
export type CommitmentResult = {
  status: "PENDING" | "CONFIRMED" | "FAILED";
  transactionSignature?: string; explorerUrl?: string; code?: string;
};
/** Narrow shape the server depends on, so tests can inject a stub without a real signer or network. */
export interface SolanaCommitmentsPort {
  record(input: CommitmentInput, persistBeforeBroadcast: (pending: { transactionSignature: string; wireTransaction: string; lastValidBlockHeight: string }) => Promise<void>): Promise<CommitmentResult>;
}

export class SolanaCommitments implements SolanaCommitmentsPort {
  constructor(private readonly signer?: KeyPairSigner, private readonly rpc = createSolanaRpc("https://api.devnet.solana.com")) {}

  /** Persist returned signature/status; reconcile PENDING rather than submitting another commitment. */
  async record(input: CommitmentInput, persistBeforeBroadcast: (pending: { transactionSignature: string; wireTransaction: string; lastValidBlockHeight: string }) => Promise<void>): Promise<CommitmentResult> {
    if (!this.signer) return { status: "FAILED", code: "NOT_CONFIGURED" };
    let signature: string | undefined;
    try {
      const data = commitment.parse(input);
      // Also prevents a misconfigured RPC from spending mainnet funds.
      if (await this.rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) }) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1") return { status: "FAILED", code: "DEVNET_REQUIRED" };
      const { value: block } = await this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(10_000) });
      const message = pipe(createTransactionMessage({ version: 0 }),
        message => setTransactionMessageFeePayerSigner(this.signer!, message),
        message => setTransactionMessageLifetimeUsingBlockhash(block, message),
        message => appendTransactionMessageInstruction({
          programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          data: new TextEncoder().encode(JSON.stringify(data)),
        }, message));
      const tx = await signTransactionMessageWithSigners(message);
      const wire = getBase64EncodedWireTransaction(tx);
      const signedSignature = getSignatureFromTransaction(tx);
      await persistBeforeBroadcast({ transactionSignature: signedSignature, wireTransaction: wire, lastValidBlockHeight: block.lastValidBlockHeight.toString() });
      signature = signedSignature;
      await this.rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: false, maxRetries: 2n, preflightCommitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(15_000) });
      return this.reconcile(signature);
    } catch {
      return signature ? { status: "PENDING", transactionSignature: signature, code: "CONFIRMATION_UNKNOWN" } : { status: "FAILED", code: "COMMITMENT_UNAVAILABLE" };
    }
  }

  async reconcile(signature: string): Promise<CommitmentResult> {
    try {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return { status: "FAILED", code: "INVALID_SIGNATURE" };
      if (await this.rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) }) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1") return { status: "FAILED", code: "DEVNET_REQUIRED" };
      const result = (await this.rpc.getSignatureStatuses([parseSignature(signature)], { searchTransactionHistory: true }).send({ abortSignal: AbortSignal.timeout(10_000) })).value[0];
      if (result?.err) return { status: "FAILED", transactionSignature: signature, code: "TRANSACTION_FAILED" };
      return result?.confirmationStatus === "confirmed" || result?.confirmationStatus === "finalized"
        ? this.confirmed(signature) : { status: "PENDING", transactionSignature: signature };
    } catch { return { status: "PENDING", transactionSignature: signature, code: "CONFIRMATION_UNKNOWN" }; }
  }

  private confirmed(signature: string): CommitmentResult {
    return { status: "CONFIRMED", transactionSignature: signature, explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet` };
  }
}
