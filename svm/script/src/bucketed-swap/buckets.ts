import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keccak256, type Address, type PublicClient } from "viem";
import {
  Reward,
  computeIntentHash,
  hashReward,
  vaultAta,
  vaultPda,
} from "../common.js";
import {
  BASE_CHAIN_ID,
  FEE_DENOMINATOR,
  FEE_NUMERATOR,
  FLAT_FEE_SOURCE,
  NUM_BUCKETS,
  SLIPPAGE_TOLERANCE,
  USDC_SOLANA,
} from "./config.js";
import {
  applySlippage,
  buildDestinationRoute,
  quoteUsdcToToshi,
} from "./destination/uniswap.js";
import type { BucketEntry } from "./types.js";
import { hexToBytes } from "./util/hex.js";

export interface VaultPair {
  vaultPda: PublicKey;
  vaultAta: PublicKey;
}

/**
 * Source-side reward (Solana USDC 6d) → destination-side route amount (Base
 * USDC 6d). Identical decimals both sides, so only scalar + flat fees apply.
 */
function calculateRouteAmount(rewardAmountSource: bigint): bigint {
  const afterScalar = (rewardAmountSource * FEE_NUMERATOR) / FEE_DENOMINATOR;
  if (afterScalar <= FLAT_FEE_SOURCE) {
    throw new Error(
      `Bucket reward ${rewardAmountSource} too small to cover flat fee ${FLAT_FEE_SOURCE}`,
    );
  }
  return afterScalar - FLAT_FEE_SOURCE;
}

/**
 * Build NUM_BUCKETS entries with reward amounts spanning Jupiter's slippage
 * floor (bucket[0]) to the live quote (bucket[N-1]), linearly. Each bucket's
 * destination Route carries a fresh USDC→TOSHI quote with tight min-out.
 */
export async function buildBuckets(params: {
  basePublic: PublicClient;
  user: Address;
  jupiterOutAmount: bigint; // live quote → bucket[N-1] floor (USDC 6d)
  jupiterMinOut: bigint; // Jupiter slippage floor → bucket[0] floor (USDC 6d)
  creator: PublicKey;
  prover: PublicKey;
  rewardDeadline: bigint;
  routeDeadline: bigint;
}): Promise<BucketEntry[]> {
  const {
    basePublic,
    user,
    jupiterOutAmount,
    jupiterMinOut,
    creator,
    prover,
    rewardDeadline,
    routeDeadline,
  } = params;

  if (jupiterMinOut >= jupiterOutAmount) {
    throw new Error(
      `jupiterMinOut (${jupiterMinOut}) must be strictly less than quote (${jupiterOutAmount})`,
    );
  }

  const entries: BucketEntry[] = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    const rewardAmount =
      jupiterMinOut +
      ((jupiterOutAmount - jupiterMinOut) * BigInt(i)) /
        BigInt(NUM_BUCKETS - 1);

    const routeAmount = calculateRouteAmount(rewardAmount);
    const toshiQuote = await quoteUsdcToToshi(basePublic, routeAmount);
    const toshiMinOut = applySlippage(toshiQuote, SLIPPAGE_TOLERANCE);

    const { routeBytes, routeStruct } = buildDestinationRoute({
      user,
      routeAmount,
      toshiMinOut,
      routeDeadline,
    });

    // SVM-native Reward — used as `baseReward` on close_and_select_intent
    // (amount=0 placeholder; program clones and sets the selected bucket's
    // rewardAmount) AND as the reward bytes Base's `fulfill` commits to, so
    // reward_hash is identical across chains.
    const reward: Reward = {
      deadline: rewardDeadline,
      creator,
      prover,
      nativeAmount: 0n,
      tokens: [{ token: USDC_SOLANA, amount: rewardAmount }],
    };

    entries.push({
      routeBytes,
      routeStruct,
      reward,
      bucket: {
        routeHash: hexToBytes(keccak256(routeBytes)),
        rewardAmount,
      },
      routeAmount,
      toshiQuote,
      toshiMinOut,
    });
  }
  return entries;
}

/**
 * Derive the (vaultPda, vaultAta) pair for every bucket using
 * intent_hash = keccak(destination_be || route_hash || reward_hash).
 * Used for the per-quote ALT and the close_and_select remaining_accounts.
 */
export function deriveBucketVaults(entries: BucketEntry[]): VaultPair[] {
  return entries.map((e) => {
    const ih = computeIntentHash(
      BASE_CHAIN_ID,
      e.bucket.routeHash,
      hashReward(e.reward),
    );
    const [vpdaPk] = vaultPda(ih);
    return {
      vaultPda: vpdaPk,
      vaultAta: vaultAta(vpdaPk, USDC_SOLANA, TOKEN_PROGRAM_ID),
    };
  });
}

/** Flatten VaultPairs → [vaultPda, vaultAta, …] for ALT packing. */
export function bucketAccountKeys(pairs: VaultPair[]): PublicKey[] {
  return pairs.flatMap((p) => [p.vaultPda, p.vaultAta]);
}
