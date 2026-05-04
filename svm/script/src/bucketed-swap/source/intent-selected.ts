import { Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";

export interface IntentSelection {
  intentHash: Uint8Array;
  delta: bigint;
  bucketIndex: number;
  rewardAmount: bigint;
}

/**
 * Pull `IntentSelected` from the tx's program logs. Anchor serializes events
 * as Base64 after a "Program data: " prefix; the first 8 bytes match
 * `sha256("event:<Name>")[..8]`.
 */
export async function parseIntentSelected(
  connection: Connection,
  sig: string,
): Promise<IntentSelection> {
  const tx = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`tx ${sig} not found`);
  const logs = tx.meta?.logMessages ?? [];

  const discriminator = eventDiscriminator("IntentSelected");
  for (const line of logs) {
    const prefix = "Program data: ";
    if (!line.startsWith(prefix)) continue;
    const decoded = Buffer.from(line.slice(prefix.length), "base64");
    if (decoded.length < 8) continue;
    if (!decoded.subarray(0, 8).equals(discriminator)) continue;

    // IntentSelected fields, in declaration order on the Rust #[event]:
    //   intent_hash: [u8; 32], user: Pubkey, delta: u64, bucket_index: u64,
    //   reward_amount: u64.
    const body = decoded.subarray(8);
    const intentHash = body.subarray(0, 32);
    const delta = body.readBigUInt64LE(64);
    const bucketIndex = Number(body.readBigUInt64LE(72));
    const rewardAmount = body.readBigUInt64LE(80);

    return { intentHash, delta, bucketIndex, rewardAmount };
  }
  throw new Error("IntentSelected event not found in tx logs");
}

function eventDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}
