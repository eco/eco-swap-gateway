/**
 * Native-SOL-input variant of `local-intent.ts`. Mirrors its structure but:
 *   - LOCAL intent reward is `{ nativeAmount: SOL_LAMPORTS, tokens: [] }`
 *   - Route's `nativeAmount = SOL_LAMPORTS, tokens = []`
 *   - Route's calls list grows from 3 to 5: open, system_transfer,
 *     sync_native, jupiter_swap, close_and_select.
 *
 * The wSOL ATA referenced by `system_transfer` and `sync_native` is
 * pre-created in a separate setup tx by `ensureExecutorWsolAta`. It must be
 * passed in here so the Route call accounts can reference it.
 *
 * No SPL token leaves the user wallet at any stage of the source-side flow.
 * The user funds the LOCAL intent vault with native lamports; flash_fulfill
 * withdraws those lamports onto flash_vault, then `Portal::fulfill::fund_executor`
 * (driven by `route.native_amount > 0`) hops them to executor. The Route
 * itself takes them the rest of the way: executor → wSOL ATA → swap → USDC.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { randomFillSync } from "node:crypto";
import {
  CHAIN_ID_SOLANA,
  LOCAL_PROVER_PROGRAM_ID,
  PORTAL_PROGRAM_ID,
  Reward,
  Route,
  buildCloseAndSelectInstruction,
  buildOpenInstruction,
  buildPortalFundInstruction,
  computeIntentHash,
  encodeCalldataWithAccounts,
  encodeRoute,
  hashReward,
  hashRoute,
  vaultPda,
} from "../../common.js";
import { SVM_HYPER_PROVER, USDC_SOLANA } from "../config.js";
import type { BucketEntry } from "../types.js";
import type { VaultPair } from "../buckets.js";
import { sendAndConfirm } from "../util/tx.js";
import { buildSyncNativeCallIx } from "./native-input.js";

/**
 * Precomputed LOCAL intent data for the native-input flow. Mirrors
 * `LocalIntent` from `local-intent.ts` but with no `vaultPenguAta` (no SPL
 * reward token at all) and the full 5-call list so flash-fulfill can derive
 * its `callAccounts` without rebuilding any ix.
 */
export interface NativeLocalIntent {
  routeBytes: Uint8Array;
  routeHash: Uint8Array;
  intentHash: Uint8Array;
  reward: Reward;
  vaultPda: PublicKey;
  /** Route calls, in execution order. Used by flash-fulfill for callAccounts. */
  routeCalls: TransactionInstruction[];
}

/**
 * Build the LOCAL intent for the native-input flow.
 *
 * Same writability-collection trick as the SPL flow: `encodeCalldataWithAccounts`
 * commits each call's accounts with their POST-DEDUP writability so the Route
 * hash matches what `Portal::fulfill::execute_route_calls` reconstructs at CPI
 * time. The wSOL ATA is captured naturally by `collectWritableKeys` walking
 * the new ixs (system_transfer marks it writable; sync_native marks it
 * writable). The wSOL mint is read-only everywhere it appears, so the union
 * is correct without explicit additions.
 */
export function buildNativeLocalIntent(params: {
  user: PublicKey;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
  executorWsolAta: PublicKey;
  sweepRecipientAta: PublicKey;
  inputLamports: bigint;
  buckets: BucketEntry[];
  vaultPairs: VaultPair[];
  jupiterSwapIx: TransactionInstruction;
  rewardDeadline: bigint;
  routeDeadline: bigint;
  destinationChainId: bigint;
}): NativeLocalIntent {
  // Mirrors the per-bucket reward in `buildBuckets` — same prover, same
  // creator, same deadline. `tokens[0].amount = 0` is the placeholder
  // close_and_select_intent fills in with the floor-selected bucket amount.
  const baseRewardForCall: Reward = {
    deadline: params.rewardDeadline,
    creator: params.user,
    prover: SVM_HYPER_PROVER,
    nativeAmount: 0n,
    tokens: [{ token: USDC_SOLANA, amount: 0n }],
  };

  const openCallIx = buildOpenInstruction(
    params.executorPda,
    params.executorUsdcAta,
  );
  const systemTransferCallIx = SystemProgram.transfer({
    fromPubkey: params.executorPda,
    toPubkey: params.executorWsolAta,
    lamports: params.inputLamports,
  });
  const syncNativeCallIx = buildSyncNativeCallIx(params.executorWsolAta);
  const closeCallIx = buildCloseAndSelectInstruction(
    {
      user: params.executorPda,
      userRewardAta: params.executorUsdcAta,
      sweepRecipientAta: params.sweepRecipientAta,
      mint: USDC_SOLANA,
    },
    {
      destination: params.destinationChainId,
      baseReward: baseRewardForCall,
      buckets: params.buckets.map((e) => e.bucket),
    },
    params.vaultPairs,
  );

  const routeCalls = [
    openCallIx,
    systemTransferCallIx,
    syncNativeCallIx,
    params.jupiterSwapIx,
    closeCallIx,
  ];

  const writableSet = collectWritableKeys(routeCalls);
  // Same dedup hazard as the SPL flow: executor PDA is writable at
  // flash_fulfill's fixed-accounts slot, and Solana's tx compiler unions
  // writability across positions. Encode the call commitment with that
  // post-dedup view so the route hash matches at CPI time.
  writableSet.add(params.executorPda.toBase58());

  const salt = Uint8Array.from(randomFillSync(Buffer.alloc(32)));
  const route: Route = {
    salt,
    deadline: params.routeDeadline,
    portal: PORTAL_PROGRAM_ID.toBytes(),
    nativeAmount: params.inputLamports,
    tokens: [],
    calls: routeCalls.map((ix) => ({
      target: ix.programId.toBytes(),
      data: encodeCalldataWithAccounts(ix, writableSet),
    })),
  };

  const reward: Reward = {
    deadline: params.rewardDeadline,
    creator: params.user,
    // local-prover: flash_fulfill CPIs into it for the prove step, and
    // portal.withdraw validates `reward.prover == prover_account.key()`.
    prover: LOCAL_PROVER_PROGRAM_ID,
    nativeAmount: params.inputLamports,
    tokens: [],
  };

  const routeBytes = encodeRoute(route);
  const routeHash = hashRoute(route);
  const rewardHash = hashReward(reward);
  const intentHash = computeIntentHash(CHAIN_ID_SOLANA, routeHash, rewardHash);
  const [vaultPdaPk] = vaultPda(intentHash);

  return {
    routeBytes,
    routeHash,
    intentHash,
    reward,
    vaultPda: vaultPdaPk,
    routeCalls,
  };
}

/**
 * Setup tx for the native-input flow:
 *   1. portal.fund — deposits `inputLamports` into the LOCAL intent vault.
 *      `transfers: []` because the reward is native-only.
 *   2. createAssociatedTokenAccountIdempotent — executor's USDC ATA, so
 *      `open` can snapshot a known pre_balance (typically 0).
 *   3. system::transfer to executor — tops up snapshot rent (~0.001 SOL of
 *      the 2_000_000 lamports). Refunded by close_and_select_intent's
 *      `close = user`. The wSOL ATA rent isn't here — that's a separate,
 *      one-off tx via `ensureExecutorWsolAta`.
 */
export async function fundNativeLocalIntent(params: {
  connection: Connection;
  userKey: Keypair;
  intent: NativeLocalIntent;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
}): Promise<string> {
  const { connection, userKey, intent } = params;
  const user = userKey.publicKey;

  const setupIxs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    buildPortalFundInstruction({
      payer: user,
      funder: user,
      vaultPda: intent.vaultPda,
      destination: CHAIN_ID_SOLANA,
      routeHash: intent.routeHash,
      reward: intent.reward,
      allowPartial: false,
      transfers: [],
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      params.executorUsdcAta,
      params.executorPda,
      USDC_SOLANA,
    ),
    // Snapshot PDA rent + safety margin. The Open ix opens a 17-byte snapshot
    // (8 disc + 8 pre_balance + 1 bump) at ~1.01M lamports rent-exempt.
    // After Open debits that, executor must remain >= 0-data rent-exempt
    // (~890,880 lamports) to be a valid system::transfer source for the
    // subsequent wSOL wrap. 3M leaves ~1M of headroom over rent floor —
    // enough to absorb future Solana rent bumps without changing this code.
    SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: params.executorPda,
      lamports: 3_000_000,
    }),
  ];

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: setupIxs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([userKey]);
  return await sendAndConfirm(connection, tx);
}

function collectWritableKeys(ixs: TransactionInstruction[]): Set<string> {
  const set = new Set<string>();
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (k.isWritable) set.add(k.pubkey.toBase58());
    }
  }
  return set;
}
