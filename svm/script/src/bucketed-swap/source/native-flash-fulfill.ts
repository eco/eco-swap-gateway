/**
 * Native-SOL-input variant of `flash-fulfill.ts`. Same overall sequence
 * (init → chunk-upload → ALT → flash_fulfill), but the LOCAL intent is
 * native-only:
 *   - `rewardTransfers: []` (no SPL token in the LOCAL reward)
 *   - `routeTransfers: []` (no SPL transfer from flash_vault to executor;
 *     `Portal::fulfill::fund_executor` hops native lamports based on
 *     `route.native_amount > 0`)
 *   - `claimantAtas: []` (no SPL claimant ATA; native leftovers — if any —
 *     are swept to claimant by `flash_fulfiller::sweep_leftover_native`)
 *
 * The new ixs in the Route (`system_transfer`, `sync_native`) reference the
 * executor's wSOL ATA. That account flows through `callAccounts` and into
 * the per-quote ALT just like any other Route account.
 *
 * Init/chunk-upload helpers are inlined here rather than imported from
 * `flash-fulfill.ts` to keep the existing PENGU demo file unchanged. The
 * helpers are source-asset agnostic; if reuse becomes valuable, they can be
 * promoted to a shared module later.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ECO_SWAP_GATEWAY_PROGRAM_ID,
  FLASH_FULFILLER_PROGRAM_ID,
  LOCAL_PROVER_PROGRAM_ID,
  PORTAL_PROGRAM_ID,
  buildAppendFlashFulfillRouteChunkInstruction,
  buildFlashFulfillInstruction,
  buildInitFlashFulfillIntentInstruction,
  chunkRouteBytes,
  eventAuthorityPda,
  flashFulfillIntentPda,
  flashVaultPda,
  fulfillMarkerPda,
  proofCloserPda,
  proofPda,
  withdrawnMarkerPda,
} from "../../common.js";
import { USDC_SOLANA, WSOL_MINT } from "../config.js";
import { createLookupTable } from "../util/lookup-table.js";
import { sendAndConfirm } from "../util/tx.js";
import type { NativeLocalIntent } from "./native-local-intent.js";

// flash_fulfiller runs a 256 KB custom allocator (see eco-routes-svm
// flash-fulfiller/src/lib.rs). Any tx invoking this program MUST request
// the matching heap frame — otherwise the allocator hands out pointers
// past the VM's default 32 KB heap region and writes access-violate.
const FLASH_FULFILLER_HEAP_BYTES = 256 * 1024;

export async function nativeFlashFulfill(params: {
  connection: Connection;
  userKey: Keypair;
  intent: NativeLocalIntent;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
  executorWsolAta: PublicKey;
  jupiterSwapIx: TransactionInstruction;
  jupiterAlts: AddressLookupTableAccount[];
  bucketAlt: AddressLookupTableAccount;
}): Promise<{
  signature: string;
  flashFulfillAlt: AddressLookupTableAccount;
}> {
  await sendInit(params);
  await uploadChunks(params);
  const flashFulfillAlt = await createFlashFulfillAlt(params);
  const signature = await sendFlashFulfill({ ...params, flashFulfillAlt });
  return { signature, flashFulfillAlt };
}

async function sendInit(params: {
  connection: Connection;
  userKey: Keypair;
  intent: NativeLocalIntent;
}): Promise<void> {
  console.log("Sending init_flash_fulfill_intent…");
  const initIx = buildInitFlashFulfillIntentInstruction({
    writer: params.userKey.publicKey,
    intentHash: params.intent.intentHash,
    routeHash: params.intent.routeHash,
    reward: params.intent.reward,
    routeTotalSize: params.intent.routeBytes.length,
  });
  const sig = await sendIxs(params.connection, params.userKey, [
    ComputeBudgetProgram.requestHeapFrame({
      bytes: FLASH_FULFILLER_HEAP_BYTES,
    }),
    initIx,
  ]);
  console.log(`  tx: ${sig}`);
}

async function uploadChunks(params: {
  connection: Connection;
  userKey: Keypair;
  intent: NativeLocalIntent;
}): Promise<void> {
  const chunks = chunkRouteBytes(params.intent.routeBytes);
  console.log(`Uploading Route in ${chunks.length} chunk(s)…`);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const appendIx = buildAppendFlashFulfillRouteChunkInstruction({
      writer: params.userKey.publicKey,
      intentHash: params.intent.intentHash,
      offset,
      chunk,
    });
    try {
      const sig = await sendIxs(params.connection, params.userKey, [
        ComputeBudgetProgram.requestHeapFrame({
          bytes: FLASH_FULFILLER_HEAP_BYTES,
        }),
        appendIx,
      ]);
      console.log(
        `  chunk ${i + 1}/${chunks.length} (${chunk.length}B @ offset ${offset}): ${sig}`,
      );
    } catch (err) {
      // Mid-upload failures leave the flash_fulfill_intent buffer
      // half-populated. The intent is unrecoverable in that state — only
      // recourse is waiting for routeDeadline and refunding the LOCAL vault.
      throw new Error(
        `Chunk upload failed at chunk ${i + 1}/${chunks.length} (offset ${offset}, ${chunk.length}B). ` +
          `LOCAL intent vault remains funded and will be refundable after routeDeadline. ` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    offset += chunk.length;
  }
  console.log();
}

async function createFlashFulfillAlt(params: {
  connection: Connection;
  userKey: Keypair;
  intent: NativeLocalIntent;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
  executorWsolAta: PublicKey;
  jupiterSwapIx: TransactionInstruction;
}): Promise<AddressLookupTableAccount> {
  const intent = params.intent;

  const [flashVaultPk] = flashVaultPda();
  const [flashFulfillIntentPk] = flashFulfillIntentPda(
    intent.intentHash,
    params.userKey.publicKey,
  );
  const [proofPk] = proofPda(intent.intentHash);
  const [proofCloserPk] = proofCloserPda();
  const [fulfillMarkerPk] = fulfillMarkerPda(intent.intentHash);
  const [withdrawnMarkerPk] = withdrawnMarkerPda(intent.intentHash);
  const [localProverEventAuthorityPk] = eventAuthorityPda(
    LOCAL_PROVER_PROGRAM_ID,
  );
  const [flashFulfillerEventAuthorityPk] = eventAuthorityPda(
    FLASH_FULFILLER_PROGRAM_ID,
  );

  // Per-quote ALT keys: every pubkey the flash_fulfill tx references that
  // we can lift out of the ix header. User keys (payer/claimant) stay in
  // the tx header; the rest goes here so the v0 tx fits under 1232B.
  const altKeys = Array.from(
    new Set(
      [
        flashVaultPk,
        flashFulfillIntentPk,
        proofPk,
        intent.vaultPda,
        withdrawnMarkerPk,
        proofCloserPk,
        params.executorPda,
        fulfillMarkerPk,
        PORTAL_PROGRAM_ID,
        LOCAL_PROVER_PROGRAM_ID,
        localProverEventAuthorityPk,
        flashFulfillerEventAuthorityPk,
        FLASH_FULFILLER_PROGRAM_ID,
        ECO_SWAP_GATEWAY_PROGRAM_ID,
        params.jupiterSwapIx.programId,
        WSOL_MINT,
        USDC_SOLANA,
        params.executorWsolAta,
        params.executorUsdcAta,
        ...intent.routeCalls.flatMap((ix) => ix.keys.map((k) => k.pubkey)),
      ].map((k) => k.toBase58()),
    ),
  ).map((s) => new PublicKey(s));

  console.log(
    `Creating per-quote flash-fulfill ALT (${altKeys.length} entries)…`,
  );
  const alt = await createLookupTable(
    params.connection,
    params.userKey,
    altKeys,
  );
  console.log(`  ALT: ${alt.key.toBase58()}`);
  console.log();
  return alt;
}

async function sendFlashFulfill(params: {
  connection: Connection;
  userKey: Keypair;
  intent: NativeLocalIntent;
  executorPda: PublicKey;
  jupiterSwapIx: TransactionInstruction;
  jupiterAlts: AddressLookupTableAccount[];
  bucketAlt: AddressLookupTableAccount;
  flashFulfillAlt: AddressLookupTableAccount;
}): Promise<string> {
  const intent = params.intent;
  const user = params.userKey.publicKey;

  const [flashVaultPk] = flashVaultPda();
  const [flashFulfillIntentPk] = flashFulfillIntentPda(intent.intentHash, user);
  const [proofPk] = proofPda(intent.intentHash);
  const [proofCloserPk] = proofCloserPda();
  const [fulfillMarkerPk] = fulfillMarkerPda(intent.intentHash);
  const [withdrawnMarkerPk] = withdrawnMarkerPda(intent.intentHash);
  const [localProverEventAuthorityPk] = eventAuthorityPda(
    LOCAL_PROVER_PROGRAM_ID,
  );
  const [flashFulfillerEventAuthorityPk] = eventAuthorityPda(
    FLASH_FULFILLER_PROGRAM_ID,
  );

  const ix = buildFlashFulfillInstruction({
    payer: user,
    flashVault: flashVaultPk,
    flashFulfillIntent: flashFulfillIntentPk,
    claimant: user,
    proof: proofPk,
    intentVault: intent.vaultPda,
    withdrawnMarker: withdrawnMarkerPk,
    proofCloser: proofCloserPk,
    executor: params.executorPda,
    fulfillMarker: fulfillMarkerPk,
    portalProgram: PORTAL_PROGRAM_ID,
    localProverProgram: LOCAL_PROVER_PROGRAM_ID,
    localProverEventAuthority: localProverEventAuthorityPk,
    flashFulfillerEventAuthority: flashFulfillerEventAuthorityPk,
    intentHash: intent.intentHash,
    // Native-only LOCAL reward: no SPL transfers anywhere on the source side.
    // Lamport flow goes vault → flash_vault (Portal::withdraw_native) →
    // executor (Portal::fulfill::fund_executor when route.native_amount > 0).
    rewardTransfers: [],
    routeTransfers: [],
    claimantAtas: [],
    // Per-call account lists, in Route execution order. Same writability
    // dedup hazard as the SPL flow: Portal reconstructs CalldataWithAccounts
    // from AccountInfo at CPI time, so the encoded route hash must match
    // the post-dedup view. The trailing program IDs sit AFTER all consumed
    // slots so they don't fall inside any call's account_count window.
    callAccounts: [
      ...intent.routeCalls.flatMap((rc) => rc.keys),
      {
        pubkey: ECO_SWAP_GATEWAY_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: params.jupiterSwapIx.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
  });

  console.log("Sending flash_fulfill tx…");
  const { blockhash } = await params.connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
      ComputeBudgetProgram.requestHeapFrame({
        bytes: FLASH_FULFILLER_HEAP_BYTES,
      }),
      ix,
    ],
  }).compileToV0Message([
    params.flashFulfillAlt,
    params.bucketAlt,
    ...params.jupiterAlts,
  ]);
  const tx = new VersionedTransaction(msg);
  tx.sign([params.userKey]);
  const serialized = tx.serialize();
  console.log(`  serialized: ${serialized.length}B`);
  if (serialized.length > 1232) {
    throw new Error(
      `flash_fulfill tx exceeds Solana's 1232-byte packet cap (${serialized.length}B). ` +
        `Reduce bucket count, or move more accounts into the per-quote ALT.`,
    );
  }
  const sig = await sendAndConfirm(params.connection, tx);
  console.log(`  tx: ${sig}`);
  return sig;
}

async function sendIxs(
  connection: Connection,
  userKey: Keypair,
  instructions: TransactionInstruction[],
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: userKey.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([userKey]);
  return await sendAndConfirm(connection, tx);
}
