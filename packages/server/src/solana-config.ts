import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, createSolanaRpc } from "@solana/kit";
import { SolanaCommitments } from "../../integrations/src/solana.js";

/** Server-only operator signer. Never pass the key or signer to a browser route. */
export async function configuredSolana(env: NodeJS.ProcessEnv = process.env): Promise<SolanaCommitments | undefined> {
  const secret = env.SOLANA_SECRET_KEY?.trim();
  if (!secret) return undefined;
  let bytes: Uint8Array;
  try {
    if (secret.startsWith("[")) {
      const values: unknown = JSON.parse(secret);
      if (!Array.isArray(values) || values.length !== 64 || values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error();
      bytes = new Uint8Array(values);
    } else {
      bytes = new Uint8Array(Buffer.from(secret, "base64"));
      if (Buffer.from(bytes).toString("base64") !== secret) throw new Error();
    }
    if (bytes.length !== 32 && bytes.length !== 64) throw new Error();
  } catch { throw new Error("SOLANA_SECRET_KEY must be a base64 32-byte seed or 64-byte JSON keypair"); }
  const signer = bytes.length === 32
    ? await createKeyPairSignerFromPrivateKeyBytes(bytes)
    : await createKeyPairSignerFromBytes(bytes);
  return new SolanaCommitments(signer, createSolanaRpc(env.SOLANA_RPC_URL || "https://api.devnet.solana.com"));
}
