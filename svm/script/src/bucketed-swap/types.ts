import type { Connection } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Bucket, Reward } from "../common.js";

export interface EVMCall {
  target: Address;
  data: Hex;
  value: bigint;
}

export interface EVMRouteStruct {
  salt: Hex;
  deadline: bigint;
  portal: Address;
  nativeAmount: bigint;
  tokens: { token: Address; amount: bigint }[];
  calls: EVMCall[];
}

/**
 * One bucket's worth of precomputed data:
 *   - EVM Route bytes (what Portal hashes on Base)
 *   - `reward`: SVM-native (Borsh) — BOTH chains commit to the same bytes.
 *     Shared reward_hash keeps intent_hash identical across chains, which
 *     the cross-chain prove → withdraw path depends on.
 *   - route/reward amounts + expected TOSHI out (for slippage logging)
 */
export interface BucketEntry {
  routeBytes: Hex;
  routeStruct: EVMRouteStruct;
  reward: Reward;
  bucket: Bucket;
  routeAmount: bigint; // USDC delivered on Base
  toshiQuote: bigint; // expected TOSHI at build time
  toshiMinOut: bigint; // slippage floor enforced by SwapRouter02
}

/**
 * Clients + keys threaded through every phase of the demo. Assembled once
 * in `bucketedSwap.ts` and passed to each phase function.
 */
export interface Context {
  connection: Connection;
  basePublic: PublicClient;
  baseWallet: WalletClient;
  userKey: Keypair;
  evmAccount: PrivateKeyAccount;
}
