/**
 * EcoSwapGateway Bucketed Example (SVM → EVM): PENGU on Solana → USDC → TOSHI on Base.
 *
 * End-to-end flow:
 *   1. User holds PENGU on Solana.
 *   2. Jupiter v6 swaps PENGU → USDC on Solana (source-side swap).
 *   3. eco-swap-gateway's `close_and_select_intent` floor-selects a bucket
 *      from the N committed in args and CPIs `Portal::fund` for bucket k —
 *      routeHash only, no `publish` prerequisite (see DESIGN.md §Portal
 *      semantics). The full user tx is
 *      `[ComputeBudget, open, <Jupiter ixs>, close_and_select]`.
 *   4. After the tx lands we parse `IntentSelected` and publish *only* the
 *      winning route via `Portal::publish`. Saves N-1 publishes of gas.
 *   5. Solver on Base (same key for this demo) approves Portal, runs
 *      `fulfill`. The Route's calls are `[approve Uniswap, exactInputSingle
 *      USDC→TOSHI]` — the Inbox delivers TOSHI to the user.
 *
 * Buckets are built around the live PENGU→USDC Jupiter quote:
 *   bucket[0]    = `otherAmountThreshold` (Jupiter's slippage floor)
 *   bucket[N-1]  = `outAmount` (the live quote)
 * Each bucket's destination Route carries a fresh USDC→TOSHI quote with a
 * tight `amountOutMinimum`.
 *
 * Uniswap SDK imports: types via `import type` (compile-time only),
 * runtime values via `createRequire` — the ESM builds that @uniswap/v3-sdk
 * ships have directory imports Node's strict resolver rejects.
 *
 * Usage:
 *   cp .env.example .env && <edit>
 *   npm install
 *   npm run demo
 */

import "dotenv/config";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash, randomFillSync } from "node:crypto";
import bs58 from "bs58";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  pad,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
// Uniswap SDK ships ESM builds with directory imports that Node's strict
// ESM resolver rejects. Pull types via `import type` and runtime values via
// createRequire (routes through the working CJS build).
import type { Token, Percent } from "@uniswap/sdk-core";
import type { FeeAmount } from "@uniswap/v3-sdk";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sdkCore =
  require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core");
const v3Sdk = require("@uniswap/v3-sdk") as typeof import("@uniswap/v3-sdk");

import { EVMRewardAbiItem, EVMRouteAbiItem, portalAbi } from "./abi/portal.js";
import { quoterV2Abi } from "./abi/quoterV2.js";
import { uniswapV3RouterAbi } from "./abi/uniswapV3Router.js";
import {
  Bucket,
  Reward,
  buildCloseAndSelectInstruction,
  buildOpenInstruction,
  buildPublishInstruction,
  computeBucketsHash,
  computeIntentHash,
  hashReward,
  vaultAta,
  vaultPda,
} from "./common.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const PENGU_INPUT_HUMAN = process.env.PENGU_INPUT ?? "100"; // default 100 PENGU
const NUM_BUCKETS = 4;
const SLIPPAGE_TOLERANCE = new sdkCore.Percent(100, 10_000); // 1% on Uniswap leg
const JUPITER_SLIPPAGE_BPS = 100; // 1% on Jupiter leg
const ROUTE_TTL_SECONDS = 3600n;
const REWARD_TTL_SECONDS = 7200n;

// Protocol fee model (matches the EVM script & DESIGN §Solver responsibilities).
// Applied off-chain per bucket — the on-chain program only hashes the Route
// we hand it.
const FEE_BPS = 6n; // 0.06% scalar fee
const FEE_DENOMINATOR = 10_000n;
const FEE_NUMERATOR = FEE_DENOMINATOR - FEE_BPS;
// Flat fee in source-chain USDC decimals (Solana USDC = 6d).
const FLAT_FEE_SOURCE = 10_000n; // $0.01

// ─── Constants ──────────────────────────────────────────────────────────────

// Solana (source)
const PENGU_MINT = new PublicKey(
  "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
);
const USDC_SOLANA = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const PENGU_DECIMALS = 6;

// Base (destination)
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOSHI_BASE: Address = "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4";
const SWAP_ROUTER_02_BASE: Address =
  "0x2626664c2603336E57B271c5C0b26F421741e481";
const QUOTER_V2_BASE: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const PORTAL_BASE: Address = "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
// Memecoin pools settle on the HIGH fee tier on Base. MEDIUM for USDC/TOSHI
// is a dust pool and severely misprices.
const USDC_TOSHI_FEE: FeeAmount = v3Sdk.FeeAmount.HIGH; // 10000
const BASE_CHAIN_ID = 8453n;
const PROVER: Address = "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";

// Uniswap SDK tokens
const USDC_BASE_TOKEN = new sdkCore.Token(
  8453,
  USDC_BASE,
  6,
  "USDC",
  "USD Coin",
);
const TOSHI_TOKEN = new sdkCore.Token(8453, TOSHI_BASE, 18, "TOSHI", "Toshi");

// ─── EVM-destination types ──────────────────────────────────────────────────

type EVMCall = { target: Address; data: Hex; value: bigint };
type EVMReward = {
  deadline: bigint;
  creator: Address;
  prover: Address;
  nativeAmount: bigint;
  tokens: { token: Address; amount: bigint }[];
};
type EVMRouteStruct = {
  salt: Hex;
  deadline: bigint;
  portal: Address;
  nativeAmount: bigint;
  tokens: { token: Address; amount: bigint }[];
  calls: EVMCall[];
};
type BucketEntry = {
  routeBytes: Hex; // abi.encode(EVMRouteStruct) — the Route bytes Portal hashes
  routeStruct: EVMRouteStruct;
  evmReward: EVMReward; // for Base fulfill
  svmReward: Reward; // for SVM close_and_select + post-publish
  bucket: Bucket;
  routeAmount: bigint; // USDC delivered on Base
  toshiQuote: bigint; // expected TOSHI at build time
  toshiMinOut: bigint; // 1%-slippage floor enforced by SwapRouter02
};

// ─── Fee/decimal math (matches EVM script) ─────────────────────────────────

function applySlippage(amount: bigint, slippage: Percent): bigint {
  const num = BigInt(slippage.numerator.toString());
  const den = BigInt(slippage.denominator.toString());
  return (amount * (den - num)) / den;
}

/**
 * Source-side reward (Solana USDC 6d) → destination-side route amount (Base
 * USDC 6d). Identical decimals on both sides, so only scalar + flat fees apply.
 * Drift between this and the EVM session's fee math is the silent-bug class
 * called out in the learnings digest (#5). Keep byte-identical.
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

// ─── Uniswap destination Route assembly ────────────────────────────────────

function buildApproveAndSwap(p: {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: FeeAmount;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): EVMCall[] {
  return [
    {
      target: p.tokenIn,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [p.router, p.amountIn],
      }),
      value: 0n,
    },
    {
      target: p.router,
      data: encodeFunctionData({
        abi: uniswapV3RouterAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: p.tokenIn,
            tokenOut: p.tokenOut,
            fee: p.fee,
            recipient: p.recipient,
            amountIn: p.amountIn,
            amountOutMinimum: p.amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
      value: 0n,
    },
  ];
}

function buildDestinationCalls(
  user: Address,
  routeAmount: bigint,
  toshiMinOut: bigint,
): EVMCall[] {
  return buildApproveAndSwap({
    router: SWAP_ROUTER_02_BASE,
    tokenIn: USDC_BASE,
    tokenOut: TOSHI_BASE,
    fee: USDC_TOSHI_FEE,
    recipient: user,
    amountIn: routeAmount,
    amountOutMinimum: toshiMinOut,
  });
}

function buildEvmRoute(
  routeAmount: bigint,
  calls: EVMCall[],
  routeDeadline: bigint,
): { routeBytes: Hex; routeStruct: EVMRouteStruct } {
  const salt = ("0x" + Buffer.from(randomSalt()).toString("hex")) as Hex;
  const routeStruct: EVMRouteStruct = {
    salt,
    deadline: routeDeadline,
    portal: PORTAL_BASE,
    nativeAmount: 0n,
    tokens: [{ token: USDC_BASE, amount: routeAmount }],
    calls,
  };
  const routeBytes = encodeAbiParameters([EVMRouteAbiItem], [routeStruct]);
  return { routeBytes, routeStruct };
}

async function quoteUsdcToToshi(
  basePublic: PublicClient,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await basePublic.simulateContract({
    address: QUOTER_V2_BASE,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: USDC_BASE,
        tokenOut: TOSHI_BASE,
        amountIn,
        fee: USDC_TOSHI_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result[0];
}

// ─── Bucket construction ────────────────────────────────────────────────────

async function buildBucketEntries(
  basePublic: PublicClient,
  user: Address,
  jupiterOutAmount: bigint, // live quote → bucket[N-1] floor (6d USDC-Solana)
  jupiterMinOut: bigint, // slippage floor → bucket[0] floor
  creatorSolana: PublicKey,
  proverSolana: PublicKey,
  rewardDeadline: bigint,
  routeDeadline: bigint,
): Promise<BucketEntry[]> {
  if (jupiterMinOut >= jupiterOutAmount) {
    throw new Error(
      `jupiterMinOut (${jupiterMinOut}) must be strictly less than quote (${jupiterOutAmount})`,
    );
  }

  const entries: BucketEntry[] = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    // bucket[0] = amountOutMinimum, bucket[N-1] = quote; linear between.
    const rewardAmount =
      jupiterMinOut +
      ((jupiterOutAmount - jupiterMinOut) * BigInt(i)) /
        BigInt(NUM_BUCKETS - 1);

    const routeAmount = calculateRouteAmount(rewardAmount);
    const toshiQuote = await quoteUsdcToToshi(basePublic, routeAmount);
    const toshiMinOut = applySlippage(toshiQuote, SLIPPAGE_TOLERANCE);

    const calls = buildDestinationCalls(user, routeAmount, toshiMinOut);
    const { routeBytes, routeStruct } = buildEvmRoute(
      routeAmount,
      calls,
      routeDeadline,
    );

    const evmReward: EVMReward = {
      deadline: rewardDeadline,
      creator: user,
      prover: PROVER,
      nativeAmount: 0n,
      tokens: [{ token: USDC_BASE, amount: rewardAmount }],
    };

    // Same reward, SVM-shape — used as `baseReward` on close_and_select_intent
    // (amount=0 placeholder; program clones and sets the selected bucket's
    // rewardAmount) and re-hydrated into the EVM reward for post-publish.
    const svmReward: Reward = {
      deadline: rewardDeadline,
      creator: creatorSolana,
      prover: proverSolana,
      nativeAmount: 0n,
      tokens: [{ token: USDC_SOLANA, amount: rewardAmount }],
    };

    entries.push({
      routeBytes,
      routeStruct,
      evmReward,
      svmReward,
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

// ─── Jupiter v6 REST client ────────────────────────────────────────────────

const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_IX_URL = "https://lite-api.jup.ag/swap/v1/swap-instructions";

interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
  }>;
  // Jupiter returns many more fields; we only read the above.
}

async function fetchJupiterQuote(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: bigint,
  slippageBps: number,
): Promise<JupiterQuote> {
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", inputMint.toBase58());
  url.searchParams.set("outputMint", outputMint.toBase58());
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", slippageBps.toString());
  url.searchParams.set("restrictIntermediateTokens", "true");
  // Single-hop routes only: multi-hop swaps bring in extra ALTs + accounts
  // that push the [open, Jupiter, close_and_select] tx past the 1232-byte
  // Solana packet limit.
  url.searchParams.set("onlyDirectRoutes", "true");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Jupiter /quote failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as JupiterQuote;
}

interface JupiterIx {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

interface JupiterSwapInstructions {
  setupInstructions?: JupiterIx[];
  swapInstruction: JupiterIx;
  cleanupInstruction?: JupiterIx;
  addressLookupTableAddresses: string[];
}

async function fetchJupiterSwapInstructions(
  quote: JupiterQuote,
  user: PublicKey,
  destinationTokenAccount: PublicKey,
): Promise<JupiterSwapInstructions> {
  const body = {
    quoteResponse: quote,
    userPublicKey: user.toBase58(),
    // Delivery lands directly on the user's USDC ATA so our snapshot-based
    // delta on that same ATA is driven purely by Jupiter's output.
    destinationTokenAccount: destinationTokenAccount.toBase58(),
    wrapAndUnwrapSol: false,
    useSharedAccounts: true,
    // We own the compute-budget ix — suppress Jupiter's default injection
    // so the final tx doesn't carry two SetComputeUnitLimit calls.
    computeUnitPriceMicroLamports: "auto",
  };
  const res = await fetch(JUPITER_SWAP_IX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Jupiter /swap-instructions failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as JupiterSwapInstructions;
}

function jupiterIxToWeb3(ix: JupiterIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function resolveJupiterAlts(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  const resolved: AddressLookupTableAccount[] = [];
  for (const addr of addresses) {
    const acct = await connection
      .getAddressLookupTable(new PublicKey(addr))
      .then((r) => r.value);
    if (acct) resolved.push(acct);
  }
  return resolved;
}

// ─── Per-quote ALT for the 2N bucket accounts ──────────────────────────────

async function createAndExtendBucketAlt(
  connection: Connection,
  payer: Keypair,
  bucketAccounts: PublicKey[],
): Promise<AddressLookupTableAccount> {
  const slot = await connection.getSlot({ commitment: "finalized" });
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });

  // Extend can include up to ~30 addresses per call (256-byte account-list
  // chunk cap). 2N <= 28 at N=14 fits in a single extend.
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    lookupTable: altAddress,
    authority: payer.publicKey,
    payer: payer.publicKey,
    addresses: bucketAccounts,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [createIx, extendIx],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await connection.sendTransaction(tx);
  await connection.confirmTransaction({
    signature: sig,
    blockhash,
    lastValidBlockHeight: (await connection.getLatestBlockhash())
      .lastValidBlockHeight,
  });

  // ALTs need at least one slot after creation before they can be used in
  // another tx. Wait until `getAddressLookupTable` resolves to a populated
  // account instead of sleep-polling.
  for (let i = 0; i < 30; i++) {
    const acct = await connection
      .getAddressLookupTable(altAddress)
      .then((r) => r.value);
    if (acct && acct.state.addresses.length > 0) return acct;
    await sleep(500);
  }
  throw new Error(`ALT ${altAddress.toBase58()} did not activate within 15s`);
}

// ─── Destination fulfill (Base) ────────────────────────────────────────────

function computeRewardHash(reward: EVMReward): Hex {
  return keccak256(encodeAbiParameters([EVMRewardAbiItem], [reward]));
}

/**
 * Compute the EVM-side intent hash. Base Portal uses ABI-encoded Route/Reward
 * (each 32-byte padded, dynamic structs head-tail) and destination as uint256
 * (32 bytes BE). The SVM-side intent hash (from `computeIntentHash` in
 * common.ts) uses Borsh-encoded structs and destination as u64 BE (8 bytes),
 * so the two hashes naturally differ for the same logical intent. Base
 * Portal's `fulfill` recomputes and validates this formula.
 */
function computeEvmIntentHash(
  destination: bigint,
  routeBytes: Hex,
  rewardBytes: Hex,
): Hex {
  const routeHash = keccak256(routeBytes);
  const rewardHash = keccak256(rewardBytes);
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
      [destination, routeHash, rewardHash],
    ),
  );
}

async function fulfillOnBase(
  baseWallet: WalletClient,
  basePublic: PublicClient,
  intentHash: Hex,
  entry: BucketEntry,
  claimant: Address,
): Promise<bigint> {
  const rewardHash = computeRewardHash(entry.evmReward);
  console.log(`Fulfilling on Base (routeAmount=${entry.routeAmount} USDC 6d)…`);

  const approveHash = await baseWallet.writeContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "approve",
    args: [PORTAL_BASE, entry.routeAmount],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
  });
  await basePublic.waitForTransactionReceipt({ hash: approveHash });

  // Alchemy's eth_estimateGas chokes on fulfill's nested-bytes[] return with
  // a spurious "-32602 Invalid params" on some providers; pass gas directly
  // to bypass estimation. 600k covers real cost (~287k on recent txs) with
  // headroom.
  const fulfillHash = await baseWallet.writeContract({
    address: PORTAL_BASE,
    abi: portalAbi,
    functionName: "fulfill",
    args: [
      intentHash,
      entry.routeStruct,
      rewardHash,
      pad(claimant, { size: 32 }),
    ],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
    gas: 600_000n,
  });
  console.log(`  fulfill tx: ${fulfillHash}`);

  const receipt = await basePublic.waitForTransactionReceipt({
    hash: fulfillHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`fulfill reverted (tx ${fulfillHash})`);
  }

  // Parse TOSHI Transfer events in *this* receipt — don't trust
  // getBalance/getTokenAccountBalance; RPC replicas lag. (Handoff digest #6.)
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receipt.logs,
  });
  let delivered = 0n;
  for (const log of transfers) {
    if (
      log.address.toLowerCase() === TOSHI_BASE.toLowerCase() &&
      log.args.to?.toLowerCase() === claimant.toLowerCase()
    ) {
      delivered += log.args.value ?? 0n;
    }
  }
  return delivered;
}

// ─── Main orchestration ─────────────────────────────────────────────────────

type Config = {
  userKey: Keypair;
  evmKey: Hex;
  rpcUrl: string;
  baseRpc: string;
};

function loadConfig(): Config {
  const userSecret = process.env.USER_SECRET_KEY;
  if (!userSecret) throw new Error("USER_SECRET_KEY not set (base58)");
  const userKey = Keypair.fromSecretKey(bs58.decode(userSecret));

  const evmKey = process.env.EVM_PRIVATE_KEY;
  if (!evmKey) throw new Error("EVM_PRIVATE_KEY not set (0x-prefixed hex)");

  return {
    userKey,
    evmKey: (evmKey.startsWith("0x") ? evmKey : "0x" + evmKey) as Hex,
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    baseRpc: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  };
}

function logHeader(config: Config) {
  console.log(`User (Solana):   ${config.userKey.publicKey.toBase58()}`);
  console.log(`Input:           ${PENGU_INPUT_HUMAN} PENGU`);
  console.log(`Destination:     Base (chain id 8453)`);
  console.log();
}

function logBuckets(entries: BucketEntry[]) {
  for (const [i, e] of entries.entries()) {
    const rh = Buffer.from(e.bucket.routeHash).toString("hex");
    console.log(
      `  [${i}] reward(src,6d)=${e.bucket.rewardAmount}  route(dst,6d)=${e.routeAmount}  routeHash=0x${rh}`,
    );
  }
  console.log();
}

function logSwapSlippage(
  label: string,
  args: {
    expectedOut: bigint;
    minOut: bigint;
    actualOut: bigint;
    decimals: number;
    symbol: string;
  },
) {
  const { expectedOut, minOut, actualOut, decimals, symbol } = args;
  const human = (v: bigint) =>
    (Number(v) / 10 ** decimals).toFixed(Math.min(decimals, 8));
  const realBps =
    expectedOut === 0n
      ? 0n
      : ((expectedOut - actualOut) * 10_000n) / expectedOut;
  const configBps =
    expectedOut === 0n ? 0n : ((expectedOut - minOut) * 10_000n) / expectedOut;
  console.log(label);
  console.log(`  quoted:  ${expectedOut} (${human(expectedOut)} ${symbol})`);
  console.log(
    `  minOut:  ${minOut}   (${human(minOut)} ${symbol}) [config ${configBps}bps]`,
  );
  console.log(`  actual:  ${actualOut}   (${human(actualOut)} ${symbol})`);
  console.log(
    `  real slippage: ${realBps}bps (${(Number(realBps) / 100).toFixed(2)}%)`,
  );
  console.log();
}

async function main() {
  const config = loadConfig();
  logHeader(config);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const basePublic = createPublicClient({ transport: http(config.baseRpc) });
  const evmAccount = privateKeyToAccount(config.evmKey);
  const baseWallet = createWalletClient({
    account: evmAccount,
    chain: base,
    transport: http(config.baseRpc),
  });

  const user = config.userKey.publicKey;
  const userRewardAta = getAssociatedTokenAddressSync(USDC_SOLANA, user);
  const sweepRecipientAta = userRewardAta; // surplus → user by default

  const inputAmount = BigInt(
    Math.round(Number(PENGU_INPUT_HUMAN) * 10 ** PENGU_DECIMALS),
  );
  const now = BigInt(Math.floor(Date.now() / 1000));
  const routeDeadline = now + ROUTE_TTL_SECONDS;
  const rewardDeadline = now + REWARD_TTL_SECONDS;

  // 1. Jupiter quote (PENGU → USDC on Solana)
  console.log("Quoting PENGU → USDC via Jupiter v6…");
  const quote = await fetchJupiterQuote(
    PENGU_MINT,
    USDC_SOLANA,
    inputAmount,
    JUPITER_SLIPPAGE_BPS,
  );
  const jupiterOutAmount = BigInt(quote.outAmount);
  const jupiterMinOut = BigInt(quote.otherAmountThreshold);
  console.log(
    `  quote:   ${jupiterOutAmount} (${(Number(jupiterOutAmount) / 1e6).toFixed(4)} USDC 6d)`,
  );
  console.log(
    `  minOut:  ${jupiterMinOut} @${JUPITER_SLIPPAGE_BPS}bps slippage`,
  );
  console.log(
    `  route:   ${quote.routePlan.map((r) => r.swapInfo.label).join(" → ")}`,
  );
  console.log();

  // 2. Build N buckets. Each bucket's destination Route encodes a fresh
  //    USDC→TOSHI Uniswap quote with tight amountOutMinimum.
  console.log(
    `Building ${NUM_BUCKETS} buckets (fee: ${FEE_BPS}bps scalar + ${FLAT_FEE_SOURCE}/1e6 USD flat)…`,
  );
  const entries = await buildBucketEntries(
    basePublic,
    evmAccount.address,
    jupiterOutAmount,
    jupiterMinOut,
    user,
    user, // prover on SVM side; PROVER const is for EVM reward
    rewardDeadline,
    routeDeadline,
  );
  logBuckets(entries);

  // 3. Derive the 2N bucket accounts (vault_pda, vault_ata pairs) once; reuse
  //    both for the per-quote ALT and for the close_and_select remaining_accounts.
  //    intent_hash = keccak(destination_be || route_hash || reward_hash)
  //    parameterizes on destination chain id (BASE_CHAIN_ID here).
  const vaultPairs = entries.map((e) => {
    const ih = computeIntentHash(
      BASE_CHAIN_ID,
      e.bucket.routeHash,
      hashReward(e.svmReward),
    );
    const [vpdaPk] = vaultPda(ih);
    return {
      vaultPda: vpdaPk,
      vaultAta: vaultAta(vpdaPk, USDC_SOLANA, TOKEN_PROGRAM_ID),
    };
  });
  const bucketAccounts = vaultPairs.flatMap((p) => [p.vaultPda, p.vaultAta]);

  console.log("Creating per-quote ALT for bucket accounts…");
  const bucketAlt = await createAndExtendBucketAlt(
    connection,
    config.userKey,
    bucketAccounts,
  );
  console.log(
    `  ALT: ${bucketAlt.key.toBase58()} (${bucketAccounts.length} entries)`,
  );
  console.log();

  // 4. Jupiter swap instructions (post-ALT so the routing can include our
  //    bucket ALT in the final ALT list).
  console.log("Fetching Jupiter swap instructions…");
  const swapIx = await fetchJupiterSwapInstructions(quote, user, userRewardAta);
  const jupiterAlts = await resolveJupiterAlts(
    connection,
    swapIx.addressLookupTableAddresses,
  );
  console.log(
    `  ixs: ${(swapIx.setupInstructions?.length ?? 0) + 1 + (swapIx.cleanupInstruction ? 1 : 0)}`,
  );
  console.log(`  ALTs: ${jupiterAlts.length}`);
  console.log();

  // 5. Build user tx [ComputeBudget, open, <Jupiter>, close_and_select].
  const baseRewardForCall: Reward = {
    deadline: rewardDeadline,
    creator: user,
    prover: user, // SVM prover; distinct from EVM reward's prover.
    nativeAmount: 0n,
    tokens: [{ token: USDC_SOLANA, amount: 0n }], // placeholder; program clones per bucket
  };

  const closeIx = buildCloseAndSelectInstruction(
    { user, userRewardAta, sweepRecipientAta, mint: USDC_SOLANA },
    {
      destination: BASE_CHAIN_ID,
      baseReward: baseRewardForCall,
      buckets: entries.map((e) => e.bucket),
    },
    vaultPairs,
  );

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });
  const userIxs: TransactionInstruction[] = [
    computeBudgetIx,
    buildOpenInstruction(user, userRewardAta),
    ...(swapIx.setupInstructions?.map(jupiterIxToWeb3) ?? []),
    jupiterIxToWeb3(swapIx.swapInstruction),
    ...(swapIx.cleanupInstruction
      ? [jupiterIxToWeb3(swapIx.cleanupInstruction)]
      : []),
    closeIx,
  ];

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: userIxs,
  }).compileToV0Message([bucketAlt, ...jupiterAlts]);
  const userTx = new VersionedTransaction(message);
  userTx.sign([config.userKey]);

  console.log(`Sending swap-and-select tx (${userTx.serialize().length}B)…`);
  const userSig = await connection.sendTransaction(userTx);
  await connection.confirmTransaction({
    signature: userSig,
    blockhash,
    lastValidBlockHeight,
  });
  console.log(`  tx: ${userSig}`);

  // 6. Parse IntentSelected event.
  const selection = await parseIntentSelected(connection, userSig, entries);
  console.log();
  console.log("Intent selected!");
  console.log(`  intentHash:    0x${hexOf(selection.intentHash)}`);
  console.log(`  bucketIndex:   ${selection.bucketIndex}`);
  console.log(`  rewardAmount:  ${selection.rewardAmount}`);
  console.log(`  swapDelta:     ${selection.delta} (USDC 6d)`);
  console.log();

  logSwapSlippage("Source swap (PENGU → USDC on Solana)", {
    expectedOut: jupiterOutAmount,
    minOut: jupiterMinOut,
    actualOut: selection.delta,
    decimals: 6,
    symbol: "USDC",
  });

  // 7. Post-publish the winning route. Fire-and-log: publish is an SLA for
  //    off-chain indexers, not required for fulfill (the intent is already
  //    funded and the solver already holds the Route bytes). For routes with
  //    multi-call EVM calldata (e.g. approve + exactInputSingle), the
  //    serialized publish tx can exceed Solana's 1232-byte packet limit.
  const selectedEntry = entries[selection.bucketIndex];
  console.log(
    `Publishing selected route (routeHash=0x${Buffer.from(selectedEntry.bucket.routeHash).toString("hex")})…`,
  );
  try {
    const publishIx = buildPublishInstruction(
      config.userKey.publicKey,
      BASE_CHAIN_ID,
      hexToBytes(selectedEntry.routeBytes),
      selectedEntry.svmReward,
    );
    const publishMsg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [publishIx],
    }).compileToV0Message();
    const publishTx = new VersionedTransaction(publishMsg);
    publishTx.sign([config.userKey]);
    const publishSig = await connection.sendTransaction(publishTx);
    await connection.confirmTransaction(publishSig);
    console.log(`  publish tx: ${publishSig}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  publish skipped: ${msg}`);
    console.log(
      `  (intent is funded on-chain; solver can still fulfill using the in-memory Route bytes)`,
    );
  }
  console.log();

  // 8. Act as solver on Base: fulfill the funded intent.
  //    Use Portal's `getIntentHash(Intent)` overload — passes the full
  //    Intent struct so Portal computes routeHash, rewardHash, and
  //    intentHash with its own exact encoding. Eliminates any chance our
  //    locally-computed routeHash differs from what fulfill recomputes.
  const intentStruct = {
    destination: BASE_CHAIN_ID,
    route: selectedEntry.routeStruct,
    reward: selectedEntry.evmReward,
  };
  const [evmIntentHash, evmRouteHash, evmRewardHash] =
    (await basePublic.readContract({
      address: PORTAL_BASE,
      abi: portalAbi,
      functionName: "getIntentHash",
      args: [intentStruct],
    })) as readonly [Hex, Hex, Hex];
  console.log(`SVM intent_hash: 0x${hexOf(selection.intentHash)}`);
  console.log(`EVM intent_hash: ${evmIntentHash}`);
  console.log(`EVM route_hash:  ${evmRouteHash}`);
  console.log(`EVM reward_hash: ${evmRewardHash}`);
  console.log();
  const toshiDelivered = await fulfillOnBase(
    baseWallet,
    basePublic,
    evmIntentHash,
    selectedEntry,
    evmAccount.address,
  );
  console.log(`  TOSHI delivered: ${toshiDelivered}`);
  console.log();

  logSwapSlippage("Destination swap (USDC → TOSHI on Base)", {
    expectedOut: selectedEntry.toshiQuote,
    minOut: selectedEntry.toshiMinOut,
    actualOut: toshiDelivered,
    decimals: TOSHI_TOKEN.decimals,
    symbol: TOSHI_TOKEN.symbol!,
  });
}

// ─── Event parsing ─────────────────────────────────────────────────────────

/**
 * Pull `IntentSelected` from the tx's program logs. Anchor serializes events
 * as Base64 after an "Event data: " prefix under "Program data:". We decode
 * with the SVM-native reward encoding just to locate our discriminator —
 * then Borsh-parse the struct.
 */
async function parseIntentSelected(
  connection: Connection,
  sig: string,
  entries: BucketEntry[],
): Promise<{
  intentHash: Uint8Array;
  delta: bigint;
  bucketIndex: number;
  rewardAmount: bigint;
  bucketsHash: Uint8Array;
}> {
  const tx = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`tx ${sig} not found`);
  const logs = tx.meta?.logMessages ?? [];

  const discriminator = anchorEventDiscriminator("IntentSelected");
  for (const line of logs) {
    const prefix = "Program data: ";
    if (!line.startsWith(prefix)) continue;
    const decoded = Buffer.from(line.slice(prefix.length), "base64");
    if (decoded.length < 8) continue;
    if (!decoded.subarray(0, 8).equals(discriminator)) continue;

    // IntentSelected fields, in declaration order on the Rust #[event]:
    // intent_hash: [u8; 32], user: Pubkey, delta: u64, bucket_index: u64,
    // reward_amount: u64, buckets_hash: [u8; 32].
    const body = decoded.subarray(8);
    const intentHash = body.subarray(0, 32);
    const delta = body.readBigUInt64LE(64);
    const bucketIndex = Number(body.readBigUInt64LE(72));
    const rewardAmount = body.readBigUInt64LE(80);
    const bucketsHash = body.subarray(88, 120);

    // Sanity-check: local bucketsHash recomputation matches event. If the
    // on-chain program selected against a different set than we hold, do
    // NOT publish a stale route.
    const localBucketsHash = computeBucketsHash(entries.map((e) => e.bucket));
    if (!Buffer.from(localBucketsHash).equals(Buffer.from(bucketsHash))) {
      throw new Error(
        `bucketsHash mismatch: event=${hexOf(bucketsHash)} local=${hexOf(localBucketsHash)}`,
      );
    }

    return { intentHash, delta, bucketIndex, rewardAmount, bucketsHash };
  }
  throw new Error("IntentSelected event not found in tx logs");
}

function anchorEventDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

// ─── Misc helpers ──────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function randomSalt(): Uint8Array {
  const out = new Uint8Array(32);
  randomFillSync(out);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ─── Entry gate ────────────────────────────────────────────────────────────

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("bucketedSwap.ts");

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
