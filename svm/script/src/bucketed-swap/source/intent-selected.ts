import { Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { computeBucketsHash } from "../../common.js";
import type { BucketEntry } from "../types.js";
import { hexOf } from "../util/hex.js";

export interface IntentSelection {
  intentHash: Uint8Array;
  delta: bigint;
  bucketIndex: number;
  rewardAmount: bigint;
  bucketsHash: Uint8Array;
}

/**
 * Pull `IntentSelected` from the tx's program logs. Anchor serializes events
 * as Base64 after a "Program data: " prefix; the first 8 bytes match
 * `sha256("event:<Name>")[..8]`.
 *
 * Cross-checks the event's bucketsHash against our local recomputation —
 * if the on-chain program selected against a different set than we hold,
 * we refuse to continue (publishing a stale route would be wrong).
 */
export async function parseIntentSelected(
  connection: Connection,
  sig: string,
  entries: BucketEntry[],
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
    //   reward_amount: u64, buckets_hash: [u8; 32].
    const body = decoded.subarray(8);
    const intentHash = body.subarray(0, 32);
    const delta = body.readBigUInt64LE(64);
    const bucketIndex = Number(body.readBigUInt64LE(72));
    const rewardAmount = body.readBigUInt64LE(80);
    const bucketsHash = body.subarray(88, 120);

    const localBucketsHash = computeBucketsHash(entries.map((e) => e.bucket));
    if (!Buffer.from(localBucketsHash).equals(Buffer.from(bucketsHash))) {
      throw new Error(
        `bucketsHash mismatch: event=${hexOf(bucketsHash)} local=${hexOf(localBucketsHash)}`,
      );
    }

    return { intentHash, delta, bucketIndex, rewardAmount, bucketsHash };
  }
  throw new Error("IntentSelected event not found in tx logs");
}

function eventDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}
