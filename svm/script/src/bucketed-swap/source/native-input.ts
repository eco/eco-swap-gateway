/**
 * Helpers for the native-SOL-input variant of the bucketed-swap demo.
 *
 * Two pieces:
 *   1. `ensureExecutorWsolAta` — pre-flight existence check; creates the
 *      executor's wSOL ATA in a one-off tx if missing. Persistent state on
 *      executor; runs at most once per executor address.
 *   2. `buildSyncNativeCallIx` — `spl_token::sync_native(wsol_ata)` Route-call
 *      ix builder. The system::transfer companion ix is built inline at the
 *      call site via `SystemProgram.transfer` (no wrapper needed — the SDK
 *      surface is already the right shape).
 *
 * The wSOL ATA's authority is the executor PDA; the runtime treats executor
 * as a signer inside `Portal::fulfill::execute_route_call` via
 * `is_signer || key == *executor`, so the system::transfer with executor as
 * source signs cleanly.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { WSOL_MINT } from "../config.js";
import { sendAndConfirm } from "../util/tx.js";

/**
 * Resolve the executor PDA's wSOL ATA address; create it on-chain if it
 * doesn't already exist. The ATA persists across runs — first invocation
 * pays ~0.00204 SOL of rent (from `userKey`), every subsequent run is a
 * no-op getAccountInfo lookup.
 *
 * `allowOwnerOffCurve = true` because executor is a PDA, not a normal wallet.
 */
export async function ensureExecutorWsolAta(params: {
  connection: Connection;
  userKey: Keypair;
  executorPda: PublicKey;
}): Promise<PublicKey> {
  const { connection, userKey, executorPda } = params;
  const wsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    executorPda,
    true,
    TOKEN_PROGRAM_ID,
  );

  const info = await connection.getAccountInfo(wsolAta, "confirmed");
  if (info) {
    console.log(`Executor wSOL ATA already initialized: ${wsolAta.toBase58()}`);
    return wsolAta;
  }

  console.log(
    `Creating executor wSOL ATA (one-off setup): ${wsolAta.toBase58()}`,
  );
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    userKey.publicKey,
    wsolAta,
    executorPda,
    WSOL_MINT,
    TOKEN_PROGRAM_ID,
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: userKey.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([userKey]);
  const sig = await sendAndConfirm(connection, tx);
  console.log(`  tx: ${sig}`);

  // Re-fetch at the same commitment we'll read from later. `confirmed` after
  // sendAndConfirm should be consistent, but on flaky RPCs the immediate
  // sibling tx (`fundNativeLocalIntent`) sometimes hits a node that hasn't
  // seen the new account yet, leading to opaque AccountNotFound failures
  // deep inside flash_fulfill. Catch it here with a clear error instead.
  const verify = await connection.getAccountInfo(wsolAta, "confirmed");
  if (!verify) {
    throw new Error(
      `Executor wSOL ATA setup tx confirmed (${sig}) but account ${wsolAta.toBase58()} not visible at "confirmed". RPC lag — re-run.`,
    );
  }
  if (!verify.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(
      `Executor wSOL ATA at ${wsolAta.toBase58()} is owned by ${verify.owner.toBase58()}, expected token program.`,
    );
  }
  return wsolAta;
}

/**
 * `spl_token::sync_native(wsol_ata)`. After a system::transfer drops lamports
 * onto a wSOL ATA, the SPL `amount` field is stale; sync_native reconciles it
 * to `lamports - rent_exempt_minimum`. The Jupiter swap then sees the input.
 */
export function buildSyncNativeCallIx(
  wsolAta: PublicKey,
): TransactionInstruction {
  return createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID);
}
