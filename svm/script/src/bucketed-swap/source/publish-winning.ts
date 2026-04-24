import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  Reward,
  buildPortalFundInstruction,
  buildPublishInstruction,
} from "../../common.js";
import { BASE_CHAIN_ID, USDC_SOLANA } from "../config.js";
import type { BucketEntry } from "../types.js";
import type { VaultPair } from "../buckets.js";
import { hexToBytes } from "../util/hex.js";
import { sendAndConfirm } from "../util/tx.js";

/**
 * Re-emit portal::IntentFunded for the downstream (Base) intent.
 * close_and_select_intent funded the vault directly (no portal CPI), so
 * portal's canonical event didn't fire. A no-op portal.fund (allow_partial=true,
 * vault already fully funded → 0 transferred) re-emits it for indexers.
 */
export async function reEmitFundedEvent(params: {
  connection: Connection;
  userKey: Keypair;
  userRewardAta: PublicKey;
  selectedEntry: BucketEntry;
  selectedVault: VaultPair;
  winningReward: Reward;
}): Promise<string> {
  const { connection, userKey } = params;
  const user = userKey.publicKey;

  const ix = buildPortalFundInstruction({
    payer: user,
    funder: user,
    vaultPda: params.selectedVault.vaultPda,
    destination: BASE_CHAIN_ID,
    routeHash: params.selectedEntry.bucket.routeHash,
    reward: params.winningReward,
    allowPartial: true,
    transfers: [
      {
        from: params.userRewardAta,
        to: params.selectedVault.vaultAta,
        mint: USDC_SOLANA,
      },
    ],
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([userKey]);
  return await sendAndConfirm(connection, tx);
}

/**
 * Best-effort: publish the winning route on-chain for indexers. Can overflow
 * 1232B for multi-call EVM calldata — logs and returns on failure since
 * fulfill doesn't require it (solver can use the in-memory Route bytes).
 */
export async function publishSelectedRoute(params: {
  connection: Connection;
  userKey: Keypair;
  selectedEntry: BucketEntry;
}): Promise<void> {
  const { connection, userKey, selectedEntry } = params;
  const user = userKey.publicKey;
  const routeHashHex = Buffer.from(selectedEntry.bucket.routeHash).toString(
    "hex",
  );
  console.log(`Publishing selected route (routeHash=0x${routeHashHex})…`);

  try {
    const ix = buildPublishInstruction(
      user,
      BASE_CHAIN_ID,
      hexToBytes(selectedEntry.routeBytes),
      selectedEntry.reward,
    );
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([userKey]);
    const sig = await sendAndConfirm(connection, tx);
    console.log(`  publish tx: ${sig}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  publish skipped: ${msg}`);
    console.log(
      `  (intent is funded on-chain; solver can still fulfill using the in-memory Route bytes)`,
    );
  }
}
