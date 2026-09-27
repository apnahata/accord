import { address, appendTransactionMessageInstruction, createSolanaRpc, createTransactionMessage, getAddressEncoder,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signature as parseSignature, signTransactionMessageWithSigners } from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";
import { z } from "zod";

// An integration payload, built from the backend's existing hash; no hashing occurs here.
const commitment = z.strictObject({
  roomPublicRef: z.string().min(1).max(80), proposalId: z.string().min(1).max(80),
  proposalVersion: z.number().int().positive(), proposalHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  eventType: z.enum(["PROPOSAL_CREATED", "PROPOSAL_STALE", "BOOKING_CONFIRMED", "GROUP_APPROVED"]),
  approvalBundleHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).superRefine((value, context) => {
  if (value.eventType === "GROUP_APPROVED" && !value.approvalBundleHash) context.addIssue({ code: "custom", path: ["approvalBundleHash"], message: "GROUP_APPROVED requires a signature bundle hash" });
});
export type CommitmentInput = z.infer<typeof commitment>;
export type CommitmentResult = {
  status: "PENDING" | "CONFIRMED" | "FAILED";
  transactionSignature?: string; explorerUrl?: string; code?: string;
};

/** Verify a wallet's exact proposal message. This is member consent evidence, never a payment authorization. */
export async function verifyProposalWalletSignature(input: { publicKey: string; signatureBase64: string; proposalId: string; version: number; proposalHash: string }): Promise<boolean> {
  try {
    if (!/^[a-fA-F0-9]{64}$/.test(input.proposalHash) || !Number.isSafeInteger(input.version) || input.version < 1) return false;
    const publicKey = getAddressEncoder().encode(address(input.publicKey));
    const signature = Buffer.from(input.signatureBase64, "base64");
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(`Accord approval\nproposalId=${input.proposalId}\nversion=${input.version}\nproposalHash=${input.proposalHash}`);
    return await crypto.subtle.verify("Ed25519", key, signature, message);
  } catch { return false; }
}

export class SolanaCommitments {
  constructor(private readonly signer?: KeyPairSigner, private readonly rpc = createSolanaRpc("https://api.devnet.solana.com")) {}

  get operatorAddress() { return this.signer?.address; }
  async devnetAvailable() {
    try { return await this.rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) }) === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; }
    catch { return false; }
  }
  async operatorReady() {
    if (!this.signer || !await this.devnetAvailable()) return false;
    try { return (await this.rpc.getBalance(this.signer.address).send({ abortSignal: AbortSignal.timeout(10_000) })).value >= 100_000n; }
    catch { return false; }
  }

  /** Persist returned signature/status; reconcile PENDING rather than submitting another commitment. */
  async record(input: CommitmentInput, persistBeforeBroadcast: (pending: { transactionSignature: string; wireTransaction: string; lastValidBlockHeight: string }) => Promise<void>): Promise<CommitmentResult> {
    if (!this.signer) return { status: "FAILED", code: "NOT_CONFIGURED" };
    let signature: string | undefined;
    try {
      const data = commitment.parse(input);
      // Also prevents a misconfigured RPC from spending mainnet funds.
      if (!await this.devnetAvailable()) return { status: "FAILED", code: "DEVNET_REQUIRED" };
      if ((await this.rpc.getBalance(this.signer.address).send({ abortSignal: AbortSignal.timeout(10_000) })).value < 100_000n) return { status: "FAILED", code: "OPERATOR_UNFUNDED" };
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

  async resumeSigned(signature: string, wireTransaction: string, lastValidBlockHeight: string): Promise<CommitmentResult> {
    const known = await this.reconcile(signature);
    if (known.status !== "PENDING") return known;
    try {
      if (!await this.devnetAvailable()) return { status: "PENDING", transactionSignature: signature, code: "DEVNET_UNAVAILABLE" };
      const blockHeight = await this.rpc.getBlockHeight({ commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(10_000) });
      if (blockHeight > BigInt(lastValidBlockHeight)) return { status: "FAILED", transactionSignature: signature, code: "BLOCKHASH_EXPIRED" };
      await this.rpc.sendTransaction(wireTransaction as ReturnType<typeof getBase64EncodedWireTransaction>, { encoding: "base64", skipPreflight: false, maxRetries: 2n, preflightCommitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(15_000) });
      return this.reconcile(signature);
    } catch { return { status: "PENDING", transactionSignature: signature, code: "CONFIRMATION_UNKNOWN" }; }
  }

  async reconcile(signature: string): Promise<CommitmentResult> {
    try {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return { status: "FAILED", code: "INVALID_SIGNATURE" };
      if (!await this.devnetAvailable()) return { status: "FAILED", code: "DEVNET_REQUIRED" };
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
