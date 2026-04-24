/**
 * EcoSwapGateway bucketed demo (SVM → EVM): PENGU on Solana → USDC → TOSHI on Base.
 *
 * End-to-end flow (orchestrated across the modules in `bucketed-swap/`):
 *   1. Jupiter quote PENGU→USDC on Solana.
 *   2. Build N buckets around the quote; each carries a fresh USDC→TOSHI
 *      Uniswap quote and its own EVM Route. Derive vault PDAs for all N.
 *   3. Per-quote ALT for the 2N bucket accounts.
 *   4. Fetch Jupiter swap instruction (authority = executor PDA so portal
 *      can invoke_signed during fulfill).
 *   5. Build the LOCAL intent (Route = [open, jupiter_swap, close_and_select])
 *      and fund it via portal.fund.
 *   6. init_flash_fulfill_intent → chunk-upload Route → flash_fulfill.
 *      flash_fulfill atomically proves+withdraws the LOCAL intent's PENGU
 *      reward and fulfills it via the executor. `close_and_select_intent`
 *      inside the Route floor-selects a bucket by USDC delta and funds the
 *      winning Base vault directly.
 *   7. Parse IntentSelected. Re-emit portal::IntentFunded for indexers.
 *      Best-effort publish the winning route.
 *   8. Act as solver on Base: fulfillAndProve (dispatches Hyperlane message
 *      back to the SVM HyperProver).
 *   9. Wait ~60s for the relay, then withdraw the USDC reward from the SVM
 *      vault into the user's ATA.
 *
 * Usage:
 *   cp .env.example .env && <edit>
 *   npm install
 *   npm run demo
 */

import {
  Connection,
  PublicKey,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import {
  BASE_CHAIN_ID,
  JUPITER_SLIPPAGE_BPS,
  PENGU_DECIMALS,
  PENGU_INPUT_HUMAN,
  PENGU_MINT,
  REWARD_TTL_SECONDS,
  ROUTE_TTL_SECONDS,
  SVM_HYPER_PROVER,
  TOSHI_TOKEN,
  USDC_SOLANA,
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
import type { BucketEntry, Context } from "./bucketed-swap/types.js";
import {
  fetchJupiterQuote,
  fetchJupiterSwap,
} from "./bucketed-swap/source/jupiter.js";
import {
  buildLocalIntent,
  fundLocalIntent,
  type LocalIntent,
} from "./bucketed-swap/source/local-intent.js";
import { flashFulfill } from "./bucketed-swap/source/flash-fulfill.js";
import { parseIntentSelected } from "./bucketed-swap/source/intent-selected.js";
import {
  publishSelectedRoute,
  reEmitFundedEvent,
} from "./bucketed-swap/source/publish-winning.js";
import { withdrawFromSource } from "./bucketed-swap/source/withdraw.js";
import { fulfillOnBase } from "./bucketed-swap/destination/fulfill.js";
import { executorPda } from "./common.js";
import { createLookupTable } from "./bucketed-swap/util/lookup-table.js";
import { hexOf } from "./bucketed-swap/util/hex.js";
import { sleep } from "./bucketed-swap/util/tx.js";
import type { Reward } from "./common.js";

async function main(): Promise<void> {
  const ctx = buildContext();
  logHeader(ctx);

  const user = ctx.userKey.publicKey;
  const userPenguAta = getAssociatedTokenAddressSync(PENGU_MINT, user);
  const userUsdcAta = getAssociatedTokenAddressSync(USDC_SOLANA, user);
  const [executorPdaPk] = executorPda();
  const executorUsdcAta = getAssociatedTokenAddressSync(
    USDC_SOLANA,
    executorPdaPk,
    true,
  );
  const executorPenguAta = getAssociatedTokenAddressSync(
    PENGU_MINT,
    executorPdaPk,
    true,
  );

  const inputAmount = BigInt(
    Math.round(Number(PENGU_INPUT_HUMAN) * 10 ** PENGU_DECIMALS),
  );
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

  const localIntent = buildLocalIntent({
    user,
    executorPda: executorPdaPk,
    executorUsdcAta,
    sweepRecipientAta: userUsdcAta,
    inputAmount,
    buckets: entries,
    vaultPairs,
    jupiterSwapIx,
    rewardDeadline,
    routeDeadline,
    destinationChainId: BASE_CHAIN_ID,
    penguMint: PENGU_MINT,
  });
  console.log(`LOCAL intent_hash: 0x${hexOf(localIntent.intentHash)}`);
  console.log(
    `  Route bytes: ${localIntent.routeBytes.length}B (> 1232 → chunked upload)\n`,
  );

  console.log("Sending setup tx (fund LOCAL intent + prep executor)…");
  const setupSig = await fundLocalIntent({
    connection: ctx.connection,
    userKey: ctx.userKey,
    intent: localIntent,
    userPenguAta,
    executorPda: executorPdaPk,
    executorUsdcAta,
    penguMint: PENGU_MINT,
  });
  console.log(`  tx: ${setupSig}\n`);

  const flashSig = await flashFulfill({
    connection: ctx.connection,
    userKey: ctx.userKey,
    intent: localIntent,
    executorPda: executorPdaPk,
    executorUsdcAta,
    executorPenguAta,
    userPenguAta,
    penguMint: PENGU_MINT,
    jupiterSwapIx,
    jupiterAlts,
    bucketAlt,
  });

  const selection = await parseIntentSelected(
    ctx.connection,
    flashSig,
    entries,
  );
  console.log("\nDownstream intent selected!");
  console.log(`  intentHash:    0x${hexOf(selection.intentHash)}`);
  console.log(`  bucketIndex:   ${selection.bucketIndex}`);
  console.log(`  rewardAmount:  ${selection.rewardAmount}`);
  console.log(`  swapDelta:     ${selection.delta} (USDC 6d)\n`);

  logSwapSlippage("Source swap (PENGU → USDC inside flash_fulfill)", {
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
  // Use the SVM user's pubkey as 32-byte claimant so the Hyperlane-delivered
  // `proof.claimant` resolves to an on-curve Solana pubkey with a USDC ATA.
  const claimant32 = ("0x" +
    Buffer.from(user.toBytes()).toString("hex")) as Hex;
  console.log(`intent_hash: ${intentHashHex}`);
  console.log(`claimant:    ${user.toBase58()} (as bytes32 on Base)\n`);

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
  console.log("Quoting PENGU → USDC via Jupiter v6…");
  const quote = await fetchJupiterQuote({
    inputMint: PENGU_MINT,
    outputMint: USDC_SOLANA,
    amount,
    slippageBps: JUPITER_SLIPPAGE_BPS,
  });
  const out = BigInt(quote.outAmount);
  const minOut = BigInt(quote.otherAmountThreshold);
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
  process.argv[1]?.endsWith("bucketedSwap.ts");

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
