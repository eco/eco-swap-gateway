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
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
  vaultAta,
  withdrawnMarkerPda,
} from "../../common.js";
import { USDC_SOLANA } from "../config.js";
import { createLookupTable } from "../util/lookup-table.js";
import { sendAndConfirm } from "../util/tx.js";
import type { LocalIntent } from "./local-intent.js";

// flash_fulfiller runs a 256 KB custom allocator (see eco-routes-svm
// flash-fulfiller/src/lib.rs). Any tx invoking this program MUST request the
// matching heap frame — otherwise the allocator hands out pointers past the
// VM's default 32 KB heap region and writes access-violate.
const FLASH_FULFILLER_HEAP_BYTES = 256 * 1024;

/**
 * End-to-end flash_fulfill sequence: init → chunk upload → flash_fulfill.
 * Returns the flash_fulfill tx signature.
 */
export async function flashFulfill(params: {
  connection: Connection;
  userKey: Keypair;
  intent: LocalIntent;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
  executorPenguAta: PublicKey;
  userPenguAta: PublicKey;
  penguMint: PublicKey;
  jupiterSwapIx: TransactionInstruction;
  jupiterAlts: AddressLookupTableAccount[];
  bucketAlt: AddressLookupTableAccount;
}): Promise<string> {
  await sendInit(params);
  await uploadChunks(params);
  const flashFulfillAlt = await createFlashFulfillAlt(params);
  return await sendFlashFulfill({ ...params, flashFulfillAlt });
}

async function sendInit(params: {
  connection: Connection;
  userKey: Keypair;
  intent: LocalIntent;
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
  intent: LocalIntent;
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
    const sig = await sendIxs(params.connection, params.userKey, [
      ComputeBudgetProgram.requestHeapFrame({
        bytes: FLASH_FULFILLER_HEAP_BYTES,
      }),
      appendIx,
    ]);
    console.log(
      `  chunk ${i + 1}/${chunks.length} (${chunk.length}B @ offset ${offset}): ${sig}`,
    );
    offset += chunk.length;
  }
  console.log();
}

async function createFlashFulfillAlt(params: {
  connection: Connection;
  userKey: Keypair;
  intent: LocalIntent;
  executorPda: PublicKey;
  executorUsdcAta: PublicKey;
  executorPenguAta: PublicKey;
  userPenguAta: PublicKey;
  penguMint: PublicKey;
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
  const flashVaultPenguAta = vaultAta(
    flashVaultPk,
    params.penguMint,
    TOKEN_PROGRAM_ID,
  );

  // Fresh ALT holding all flash_fulfill-specific pubkeys we can lift out.
  // User keys (payer / claimant) stay in the tx header; everything else
  // goes in the ALT to stay under 1232B with this account count.
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
        params.penguMint,
        USDC_SOLANA,
        intent.vaultPenguAta,
        flashVaultPenguAta,
        params.executorPenguAta,
        params.executorUsdcAta,
        params.userPenguAta,
        ...intent.openCallIx.keys.map((k) => k.pubkey),
        ...intent.closeCallIx.keys.map((k) => k.pubkey),
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
  intent: LocalIntent;
  executorPda: PublicKey;
  executorPenguAta: PublicKey;
  userPenguAta: PublicKey;
  penguMint: PublicKey;
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
  const flashVaultPenguAta = vaultAta(
    flashVaultPk,
    params.penguMint,
    TOKEN_PROGRAM_ID,
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
    rewardTransfers: [
      {
        from: intent.vaultPenguAta,
        to: flashVaultPenguAta,
        mint: params.penguMint,
      },
    ],
    routeTransfers: [
      {
        from: flashVaultPenguAta,
        to: params.executorPenguAta,
        mint: params.penguMint,
      },
    ],
    claimantAtas: [params.userPenguAta],
    // Ordering is LOAD-BEARING: portal.fulfill's execute_route_calls consumes
    // remaining_accounts in strict order, `calldata.account_count` entries per
    // Call. Target program AccountInfos must NOT fall inside any call's
    // consumed range or Anchor will read them at the wrong field positions.
    // Append them AFTER all consumed slots — still in the tx's loaded-accounts
    // set (which Solana uses to resolve invoke_signed target program IDs),
    // just not consumed by portal's per-call iterator.
    callAccounts: [
      ...intent.openCallIx.keys,
      ...params.jupiterSwapIx.keys,
      ...intent.closeCallIx.keys,
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
    // CU limit at the max (1.4M): flash_fulfill does prove + withdraw +
    // fulfill + route-calls (incl. a full Jupiter swap) + sweeps in one
    // invocation. Priority fee ensures inclusion on busy slots (200k
    // microlamports/CU × 1.4M CU ≈ 0.00028 SOL ceiling).
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
  console.log(`  serialized: ${tx.serialize().length}B`);
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
