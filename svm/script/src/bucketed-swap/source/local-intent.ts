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
import {
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { randomFillSync } from "node:crypto";
import {
  CHAIN_ID_SOLANA,
  ECO_SWAP_GATEWAY_PROGRAM_ID,
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
  vaultAta,
  vaultPda,
} from "../../common.js";
import { SVM_HYPER_PROVER, USDC_SOLANA } from "../config.js";
import type { BucketEntry } from "../types.js";
import type { VaultPair } from "../buckets.js";
import { sendAndConfirm } from "../util/tx.js";

/**
 * Precomputed LOCAL intent data: the same-chain intent whose reward is the
 * user's PENGU input and whose Route wraps the Jupiter swap + close_and_select.
 * `flash_fulfill` consumes this intent atomically.
 */
export interface LocalIntent {
  routeBytes: Uint8Array;
  routeHash: Uint8Array;
  intentHash: Uint8Array;
  reward: Reward;
  vaultPda: PublicKey;
  vaultPenguAta: PublicKey;
  // Needed by flash-fulfill to build callAccounts + the per-session ALT.
  openCallIx: TransactionInstruction;
  closeCallIx: TransactionInstruction;
}

/**
 * Build the LOCAL intent — same-chain (destination = CHAIN_ID_SOLANA).
 * Route calls are `[open, jupiter_swap, close_and_select]`, run inside
 * portal.fulfill's executor context during flash_fulfill.
 *
 * Route-call writability: precompute the MAX `isWritable` for every pubkey
 * that appears in ANY of the three call ixs. Solana's tx compiler dedups
 * each pubkey with the most-permissive flags, and portal reconstructs
 * CalldataWithAccounts from the resulting AccountInfo at CPI time — so the
 * committed CalldataWithAccounts must match the post-dedup view or the route
 * hash diverges from portal's reconstruction and fulfill reverts with
 * InvalidIntentHash.
 */
export function buildLocalIntent(params: {
  user: PublicKey;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
  sweepRecipientAta: PublicKey;
  inputAmount: bigint;
  buckets: BucketEntry[];
  vaultPairs: VaultPair[];
  jupiterSwapIx: TransactionInstruction;
  rewardDeadline: bigint;
  routeDeadline: bigint;
  destinationChainId: bigint;
  penguMint: PublicKey;
}): LocalIntent {
  // Must mirror the per-bucket `reward` built in `buildBuckets` — the
  // Solana Portal's `withdraw` recomputes `types::intent_hash(dst,
  // route_hash, reward.hash())` and derives the proof PDA at
  // `Proof::pda(intent_hash, reward.prover)`, so the prover here has to be
  // the same HyperProver program the Base side routes its proof through.
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

  const writableSet = collectWritableKeys([
    openCallIx,
    params.jupiterSwapIx,
    closeCallIx,
  ]);
  // executor PDA is writable at the outer flash_fulfill fixed-accounts slot;
  // that dedups with jupiter's readonly appearance and flips it writable.
  writableSet.add(params.executorPda.toBase58());

  const salt = Uint8Array.from(randomFillSync(Buffer.alloc(32)));
  const route: Route = {
    salt,
    deadline: params.routeDeadline,
    portal: PORTAL_PROGRAM_ID.toBytes(),
    nativeAmount: 0n,
    tokens: [{ token: params.penguMint, amount: params.inputAmount }],
    calls: [
      {
        target: ECO_SWAP_GATEWAY_PROGRAM_ID.toBytes(),
        data: encodeCalldataWithAccounts(openCallIx, writableSet),
      },
      {
        target: params.jupiterSwapIx.programId.toBytes(),
        data: encodeCalldataWithAccounts(params.jupiterSwapIx, writableSet),
      },
      {
        target: ECO_SWAP_GATEWAY_PROGRAM_ID.toBytes(),
        data: encodeCalldataWithAccounts(closeCallIx, writableSet),
      },
    ],
  };

  const reward: Reward = {
    deadline: params.rewardDeadline,
    creator: params.user,
    // portal.withdraw validates `reward.prover == prover_account.key()`, and
    // flash_fulfill CPIs into the local-prover program — so the reward must
    // commit to the local-prover's program ID, not the user.
    prover: LOCAL_PROVER_PROGRAM_ID,
    nativeAmount: 0n,
    tokens: [{ token: params.penguMint, amount: params.inputAmount }],
  };

  const routeBytes = encodeRoute(route);
  const routeHash = hashRoute(route);
  const rewardHash = hashReward(reward);
  const intentHash = computeIntentHash(CHAIN_ID_SOLANA, routeHash, rewardHash);
  const [vaultPdaPk] = vaultPda(intentHash);
  const vaultPenguAta = vaultAta(
    vaultPdaPk,
    params.penguMint,
    TOKEN_PROGRAM_ID,
  );

  return {
    routeBytes,
    routeHash,
    intentHash,
    reward,
    vaultPda: vaultPdaPk,
    vaultPenguAta,
    openCallIx,
    closeCallIx,
  };
}

/**
 * Setup tx: fund the LOCAL intent with PENGU via portal.fund, pre-create
 * the executor's USDC ATA (so open can snapshot pre_balance=0), and top up
 * the executor PDA with lamports for the snapshot PDA's rent (refunded at
 * close_and_select time, so repeated runs don't drift balances up).
 */
export async function fundLocalIntent(params: {
  connection: Connection;
  userKey: Keypair;
  intent: LocalIntent;
  userPenguAta: PublicKey;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
  penguMint: PublicKey;
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
      transfers: [
        {
          from: params.userPenguAta,
          to: intent.vaultPenguAta,
          mint: params.penguMint,
        },
      ],
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      params.executorUsdcAta,
      params.executorPda,
      USDC_SOLANA,
    ),
    SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: params.executorPda,
      lamports: 2_000_000,
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
