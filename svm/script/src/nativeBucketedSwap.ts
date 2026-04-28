/**
 * EcoSwapGateway bucketed demo (SVM → EVM): SOL on Solana → USDC → TOSHI on Base.
 *
 * Mirrors `bucketedSwap.ts` but with native SOL as the source asset:
 *   - LOCAL intent reward is `nativeAmount: SOL_LAMPORTS, tokens: []` instead
 *     of an SPL token. The user funds it from their wallet's lamport balance.
 *   - Pre-flight: ensure the executor's wSOL ATA exists. If not, run a
 *     one-off `createAssociatedTokenAccountIdempotent` tx (~0.00204 SOL of
 *     persistent rent on executor; paid by the user wallet running this
 *     script). Subsequent runs reuse it.
 *   - Per-run Route gains two extra calls between `open` and the Jupiter
 *     swap: `system::transfer(executor → executor_wsol_ata, SOL_LAMPORTS)`
 *     and `spl_token::sync_native(executor_wsol_ata)`. Together they wrap
 *     the lamports Portal::fulfill::fund_executor deposited into the wSOL
 *     ATA so Jupiter sees it as the swap input.
 *
 * The destination side (USDC → TOSHI on Base via Uniswap, fulfillAndProve,
 * Hyperlane relay, withdraw on Solana) is unchanged from the PENGU demo.
 *
 * Usage:
 *   cp .env.example .env && <edit>
 *   npm install
 *   npm run demo:native     (or directly: tsx src/nativeBucketedSwap.ts)
 */

import { Connection, type AddressLookupTableAccount } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import {
  BASE_CHAIN_ID,
  JUPITER_SLIPPAGE_BPS,
  REWARD_TTL_SECONDS,
  ROUTE_TTL_SECONDS,
  SOL_DECIMALS,
  SOL_INPUT_LAMPORTS,
  SVM_HYPER_PROVER,
  TOSHI_TOKEN,
  USDC_SOLANA,
  WSOL_MINT,
  loadConfig,
} from "./bucketed-swap/config.js";
import {
  bucketAccountKeys,
  buildBuckets,
  deriveBucketVaults,
} from "./bucketed-swap/buckets.js";
import {
  logBuckets,
  logHeader,
  logSwapSlippage,
} from "./bucketed-swap/logging.js";
import type { Context } from "./bucketed-swap/types.js";
import {
  fetchJupiterQuote,
  fetchJupiterSwap,
} from "./bucketed-swap/source/jupiter.js";
import {
  buildNativeLocalIntent,
  fundNativeLocalIntent,
} from "./bucketed-swap/source/native-local-intent.js";
import { ensureExecutorWsolAta } from "./bucketed-swap/source/native-input.js";
import { nativeFlashFulfill } from "./bucketed-swap/source/native-flash-fulfill.js";
import { parseIntentSelected } from "./bucketed-swap/source/intent-selected.js";
import {
  publishSelectedRoute,
  reEmitFundedEvent,
} from "./bucketed-swap/source/publish-winning.js";
import { withdrawFromSource } from "./bucketed-swap/source/withdraw.js";
import { fulfillOnBase } from "./bucketed-swap/destination/fulfill.js";
import { executorPda } from "./common.js";
import {
  createLookupTable,
  deactivateLookupTables,
} from "./bucketed-swap/util/lookup-table.js";
import { hexOf } from "./bucketed-swap/util/hex.js";
import { sleep } from "./bucketed-swap/util/tx.js";
import type { Reward } from "./common.js";

async function main(): Promise<void> {
  const ctx = buildContext();
  logHeader(ctx);

  const user = ctx.userKey.publicKey;
  const userUsdcAta = getAssociatedTokenAddressSync(USDC_SOLANA, user);
  const [executorPdaPk] = executorPda();
  const executorUsdcAta = getAssociatedTokenAddressSync(
    USDC_SOLANA,
    executorPdaPk,
    true,
  );

  // Pre-flight balance check. Catches the most common operator footgun
  // (insufficient SOL) BEFORE we send any tx, so we never leave half-built
  // on-chain state. The estimate covers: input lamports, snapshot rent
  // top-up, ALT rent (× 2 for bucketAlt + flashFulfillAlt), wSOL ATA rent
  // (one-off; ignored on subsequent runs), tx fees, priority fees.
  const balance = BigInt(await ctx.connection.getBalance(user, "confirmed"));
  const minimumNeeded =
    SOL_INPUT_LAMPORTS + 3_000_000n + 5_000_000n + 5_000_000n + 1_000_000n;
  if (balance < minimumNeeded) {
    throw new Error(
      `Insufficient SOL on user wallet ${user.toBase58()}.\n` +
        `  Have:   ${balance} lamports (${(Number(balance) / 1e9).toFixed(4)} SOL)\n` +
        `  Need:   ~${minimumNeeded} lamports (${(Number(minimumNeeded) / 1e9).toFixed(4)} SOL) minimum\n` +
        `  Breakdown: ${SOL_INPUT_LAMPORTS} swap input + 3M executor top-up + ~5M each for two ALT rents + ~1M tx fees`,
    );
  }

  // Pre-flight: ensure executor's wSOL ATA exists. One-off tx; idempotent
  // across runs (existence check + early-return). The ATA persists on
  // executor so subsequent runs skip straight past the check.
  const executorWsolAta = await ensureExecutorWsolAta({
    connection: ctx.connection,
    userKey: ctx.userKey,
    executorPda: executorPdaPk,
  });
  console.log();

  const inputAmount = SOL_INPUT_LAMPORTS;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const routeDeadline = now + ROUTE_TTL_SECONDS;
  const rewardDeadline = now + REWARD_TTL_SECONDS;

  const quote = await quoteSourceSwap(ctx, inputAmount);

  const entries = await buildBuckets({
    basePublic: ctx.basePublic,
    user: ctx.evmAccount.address,
    jupiterOutAmount: BigInt(quote.outAmount),
    jupiterMinOut: BigInt(quote.otherAmountThreshold),
    creator: user,
    prover: SVM_HYPER_PROVER,
    rewardDeadline,
    routeDeadline,
  });
  logBuckets(entries);

  const vaultPairs = deriveBucketVaults(entries);
  const bucketAlt = await buildBucketAlt(ctx, vaultPairs);

  console.log("Fetching Jupiter swap instructions…");
  const { swapIx: jupiterSwapIx, alts: jupiterAlts } = await fetchJupiterSwap({
    connection: ctx.connection,
    quote,
    authority: executorPdaPk,
    destinationTokenAccount: executorUsdcAta,
  });
  console.log(`  ix accounts: ${jupiterSwapIx.keys.length}`);
  console.log(`  ALTs: ${jupiterAlts.length}\n`);

  const localIntent = buildNativeLocalIntent({
    user,
    executorPda: executorPdaPk,
    executorUsdcAta,
    executorWsolAta,
    sweepRecipientAta: userUsdcAta,
    inputLamports: inputAmount,
    buckets: entries,
    vaultPairs,
    jupiterSwapIx,
    rewardDeadline,
    routeDeadline,
    destinationChainId: BASE_CHAIN_ID,
  });
  console.log(`LOCAL intent_hash: 0x${hexOf(localIntent.intentHash)}`);
  console.log(
    `  Route bytes: ${localIntent.routeBytes.length}B (> 1232 → chunked upload)\n`,
  );

  console.log("Sending setup tx (fund LOCAL intent + prep executor)…");
  const setupSig = await fundNativeLocalIntent({
    connection: ctx.connection,
    userKey: ctx.userKey,
    intent: localIntent,
    executorPda: executorPdaPk,
    executorUsdcAta,
  });
  console.log(`  tx: ${setupSig}\n`);

  const { signature: flashSig, flashFulfillAlt } = await nativeFlashFulfill({
    connection: ctx.connection,
    userKey: ctx.userKey,
    intent: localIntent,
    executorPda: executorPdaPk,
    executorUsdcAta,
    executorWsolAta,
    jupiterSwapIx,
    jupiterAlts,
    bucketAlt,
  });

  const selection = await parseIntentSelected(
    ctx.connection,
    flashSig,
    entries,
  );
  // Defensive guard: an unexpected on-chain bucket_index (program drift,
  // malformed event) would silently dereference undefined later. By the time
  // we get here flash_fulfill has already executed and USDC sits on the
  // executor — surface a precise error so the operator can manually
  // recover instead of seeing `Cannot read properties of undefined`.
  if (selection.bucketIndex < 0 || selection.bucketIndex >= entries.length) {
    throw new Error(
      `IntentSelected event reported bucketIndex=${selection.bucketIndex}, ` +
        `but only ${entries.length} buckets were submitted. flash_fulfill tx: ${flashSig}. ` +
        `USDC is on executor's ATA; manual recovery required.`,
    );
  }
  console.log("\nDownstream intent selected!");
  console.log(`  intentHash:    0x${hexOf(selection.intentHash)}`);
  console.log(`  bucketIndex:   ${selection.bucketIndex}`);
  console.log(`  rewardAmount:  ${selection.rewardAmount}`);
  console.log(`  swapDelta:     ${selection.delta} (USDC 6d)\n`);

  logSwapSlippage("Source swap (SOL → USDC inside flash_fulfill)", {
    expectedOut: BigInt(quote.outAmount),
    minOut: BigInt(quote.otherAmountThreshold),
    actualOut: selection.delta,
    decimals: 6,
    symbol: "USDC",
  });

  const selectedEntry = entries[selection.bucketIndex];
  const winningReward = withSelectedAmount(
    selectedEntry.reward,
    selection.rewardAmount,
  );
  const winningVault = vaultPairs[selection.bucketIndex];

  console.log("Re-emitting portal::IntentFunded (no-op portal.fund)…");
  const reEmitSig = await reEmitFundedEvent({
    connection: ctx.connection,
    userKey: ctx.userKey,
    userRewardAta: userUsdcAta,
    selectedEntry,
    selectedVault: winningVault,
    winningReward,
  });
  console.log(`  tx: ${reEmitSig}`);

  await publishSelectedRoute({
    connection: ctx.connection,
    userKey: ctx.userKey,
    selectedEntry,
  });
  console.log();

  const intentHashHex = ("0x" + hexOf(selection.intentHash)) as Hex;
  const claimant32 = ("0x" +
    Buffer.from(user.toBytes()).toString("hex")) as Hex;
  console.log(`intent_hash: ${intentHashHex}`);
  console.log(`claimant:    ${user.toBase58()} (as bytes32 on Base)\n`);

  // Deadline guard. Jupiter quoting + ALT creation + chunked uploads can
  // collectively eat into ROUTE_TTL_SECONDS, especially on a slow RPC.
  // Failing here is recoverable (USDC sits in the Base-side vault and refunds
  // after deadline); reverting on Base is not (gas spent, no recovery).
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (nowSec >= selectedEntry.routeStruct.deadline) {
    throw new Error(
      `Route deadline ${selectedEntry.routeStruct.deadline} already elapsed (now=${nowSec}). ` +
        `Aborting before the Base fulfillAndProve to avoid wasted gas. ` +
        `The Base vault will be refundable after its deadline.`,
    );
  }

  const toshiDelivered = await fulfillOnBase({
    baseWallet: ctx.baseWallet,
    basePublic: ctx.basePublic,
    intentHash: intentHashHex,
    entry: selectedEntry,
    claimant32,
    toshiRecipient: ctx.evmAccount.address,
  });
  console.log(`  TOSHI delivered: ${toshiDelivered}\n`);

  logSwapSlippage("Destination swap (USDC → TOSHI on Base)", {
    expectedOut: selectedEntry.toshiQuote,
    minOut: selectedEntry.toshiMinOut,
    actualOut: toshiDelivered,
    decimals: TOSHI_TOKEN.decimals,
    symbol: TOSHI_TOKEN.symbol!,
  });

  console.log("Waiting 60s for Hyperlane relay (Base → Solana)…");
  await sleep(60_000);
  await withdrawFromSource({
    connection: ctx.connection,
    userKey: ctx.userKey,
    userRewardAta: userUsdcAta,
    intentHash: selection.intentHash,
    routeHash: selectedEntry.bucket.routeHash,
    rewardAmount: selection.rewardAmount,
    winningReward,
  });

  // ALT cleanup (phase 1 of 2). See bucketedSwap.ts for the full rationale —
  // each run creates two single-use ALTs whose contents are tied to this
  // quote. We deactivate both immediately and leave phase 2 (close + rent
  // refund after the ~513-slot cooldown) to a separate sweeper cron.
  //
  // The executor wSOL ATA created during pre-flight is NOT cleaned up — it
  // persists across runs by design.
  //
  // Best-effort: a failure here means a slow leak (~0.008 SOL per orphaned
  // ALT) that the sweeper can still reap, but the swap itself succeeded.
  // Don't propagate the error; logging is enough.
  console.log("Deactivating per-quote ALTs (phase 1 of 2)…");
  try {
    const deactivateSig = await deactivateLookupTables(
      ctx.connection,
      ctx.userKey,
      [bucketAlt, flashFulfillAlt],
    );
    console.log(`  tx: ${deactivateSig}`);
    console.log(
      `  NOTE: close + rent refund requires a cron job (see bucketedSwap.ts).`,
    );
  } catch (err) {
    console.warn(
      `  WARN: ALT deactivation failed; swap completed but ${bucketAlt.key.toBase58()} ` +
        `and ${flashFulfillAlt.key.toBase58()} still active. The sweeper cron will ` +
        `pick them up once their authority's other ALTs are scanned. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildContext(): Context {
  const config = loadConfig();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const basePublic = createPublicClient({ transport: http(config.baseRpc) });
  const evmAccount = privateKeyToAccount(config.evmKey);
  const baseWallet = createWalletClient({
    account: evmAccount,
    chain: base,
    transport: http(config.baseRpc),
  });
  return {
    connection,
    basePublic,
    baseWallet,
    userKey: config.userKey,
    evmAccount,
  };
}

async function quoteSourceSwap(ctx: Context, amount: bigint) {
  console.log("Quoting SOL → USDC via Jupiter v6…");
  const quote = await fetchJupiterQuote({
    inputMint: WSOL_MINT,
    outputMint: USDC_SOLANA,
    amount,
    slippageBps: JUPITER_SLIPPAGE_BPS,
  });
  const out = BigInt(quote.outAmount);
  const minOut = BigInt(quote.otherAmountThreshold);
  const inHuman = (Number(amount) / 10 ** SOL_DECIMALS).toFixed(4);
  console.log(`  in:      ${amount} (${inHuman} SOL)`);
  console.log(`  quote:   ${out} (${(Number(out) / 1e6).toFixed(4)} USDC 6d)`);
  console.log(`  minOut:  ${minOut} @${JUPITER_SLIPPAGE_BPS}bps slippage`);
  console.log(
    `  route:   ${quote.routePlan.map((r) => r.swapInfo.label).join(" → ")}\n`,
  );
  return quote;
}

async function buildBucketAlt(
  ctx: Context,
  vaultPairs: ReturnType<typeof deriveBucketVaults>,
): Promise<AddressLookupTableAccount> {
  console.log("Creating per-quote ALT for bucket accounts…");
  const accounts = bucketAccountKeys(vaultPairs);
  const alt = await createLookupTable(ctx.connection, ctx.userKey, accounts);
  console.log(`  ALT: ${alt.key.toBase58()} (${accounts.length} entries)\n`);
  return alt;
}

function withSelectedAmount(reward: Reward, amount: bigint): Reward {
  return {
    ...reward,
    tokens: [{ ...reward.tokens[0], amount }],
  };
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("nativeBucketedSwap.ts");

if (invokedDirectly) {
  main().catch((err) => {
    console.error("\n=== FAILURE ===");
    console.error(err);
    console.error(
      "\nIf this failed AFTER 'Sending setup tx' completed but BEFORE the " +
        "flash_fulfill tx confirmed, your SOL is locked in the LOCAL intent " +
        "vault. The intent_hash is logged above; refund via Portal::refund " +
        "after rewardDeadline (~2h from setup). If it failed AFTER " +
        "flash_fulfill but BEFORE fulfillOnBase, USDC is on the executor " +
        "PDA's ATA — manual recovery required (contact ops).",
    );
    process.exit(1);
  });
}
