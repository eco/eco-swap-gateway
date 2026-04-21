/**
 * EcoSwapGateway Bucketed Example: DOGE on BSC → USDC (BSC) → TOSHI on Base
 *
 * End-to-end flow:
 *   1. User holds DOGE on BSC.
 *   2. Gateway swaps DOGE → USDC on BSC (Uniswap V3, source-side swap).
 *   3. Gateway funds one bucketed intent via Portal.fund. The intent's
 *      destination Route contains a *second* swap: on Base, the Inbox
 *      uses the funded USDC to approve Uniswap V3 SwapRouter02 and
 *      swap USDC → TOSHI, delivering TOSHI to the user.
 *   4. After the IntentSelected event tells us which bucket was funded,
 *      we publish *only that* Route via Portal.publish so solvers can
 *      discover it. Saves N-1 publishes' worth of gas.
 *   5. Solver fulfills the Route on Base, completing the cross-chain swap.
 *
 * Buckets are built around the live DOGE→USDC quote on BSC; each bucket's
 * destination Route encodes a tight `amountOutMinimum` derived from a live
 * USDC→TOSHI quote on Base.
 *
 * Uniswap SDK usage:
 *   - `Token` / `Percent` from @uniswap/sdk-core for typed currency + slippage
 *   - `FeeAmount` from @uniswap/v3-sdk for fee-tier constants
 *
 * Usage:
 *   PRIVATE_KEY=0x... ECO_SWAP_GATEWAY_ADDRESS=0x... PORTAL_BSC=0x... \
 *     npm run swap-select
 */

import "dotenv/config";
import crypto from "node:crypto";
import {
  createWalletClient,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  pad,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { bsc, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
// Uniswap SDK ships ESM builds with directory imports that Node's strict
// ESM resolver rejects (ERR_UNSUPPORTED_DIR_IMPORT). We pull types via
// `import type` (compile-time only) and runtime values via createRequire
// which routes through the working CJS build.
import type { Token, Percent } from "@uniswap/sdk-core";
import type { FeeAmount } from "@uniswap/v3-sdk";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sdkCore =
  require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core");
const v3Sdk = require("@uniswap/v3-sdk") as typeof import("@uniswap/v3-sdk");

import { ecoSwapGatewayAbi } from "./abi/ecoSwapGateway.js";
import { EVMRewardAbiItem, EVMRouteAbiItem, portalAbi } from "./abi/portal.js";
import { uniswapV3RouterAbi } from "./abi/uniswapV3Router.js";
import { quoterV2Abi } from "./abi/quoterV2.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const DOGE_INPUT_HUMAN = process.env.DOGE_INPUT ?? "0.5"; // default 0.5 DOGE
const NUM_BUCKETS = 6;
// Buckets span ±BAND_BPS around the live quote's central estimate.
const BAND_BPS = 2000n; // ±20%
const SLIPPAGE_TOLERANCE = new sdkCore.Percent(100, 10_000); // 1% on each Uniswap leg
const ROUTE_TTL_SECONDS = 3600n;
const REWARD_TTL_SECONDS = 7200n;

// Protocol fee model (matches swapAndCreateIntent.ts). Applied off-chain per
// bucket because F2 has no visibility into Route bytes — the script must bake
// both the scalar and flat-fee deductions into the encoded destination amount.
const FEE_BPS = 6n; // 0.06% scalar fee
const FEE_DENOMINATOR = 10_000n;
const FEE_NUMERATOR = FEE_DENOMINATOR - FEE_BPS;
// Flat fee denominated in source-chain USDC (18-dec on BSC).
const FLAT_FEE_SOURCE = parseUnits("0.01", 18); // $0.01

// ─── Constants ──────────────────────────────────────────────────────────────

// BSC (source)
const DOGE_BSC: Address = "0xbA2aE424d960c26247Dd6c32edC70B295c744C43";
const USDC_BSC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const UNISWAP_V3_ROUTER_BSC: Address =
  "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2";
const QUOTER_V2_BSC: Address = "0x78D78E420Da98ad378D7799bE8f4AF69033EB077";
const DOGE_USDC_FEE: FeeAmount = v3Sdk.FeeAmount.MEDIUM; // 3000
const PROVER: Address = "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";

// Base (destination)
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOSHI_BASE: Address = "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4";
const SWAP_ROUTER_02_BASE: Address =
  "0x2626664c2603336E57B271c5C0b26F421741e481";
const QUOTER_V2_BASE: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const PORTAL_BASE: Address = "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
// Memecoin pools typically settle on the HIGH fee tier; the MEDIUM pool for
// USDC/TOSHI on Base is a dust pool (<$1 USDC reserve) that severely
// misprices — swapping against it loses ~85% of value even with a tight
// amountOutMinimum, because the quote itself reflects the stale pool.
const USDC_TOSHI_FEE: FeeAmount = v3Sdk.FeeAmount.HIGH; // 10000
const BASE_CHAIN_ID = 8453n;

// Uniswap SDK tokens
const DOGE_TOKEN = new sdkCore.Token(56, DOGE_BSC, 8, "DOGE", "Dogecoin");
const USDC_BSC_TOKEN = new sdkCore.Token(56, USDC_BSC, 18, "USDC", "USD Coin");
const USDC_BASE_TOKEN = new sdkCore.Token(
  8453,
  USDC_BASE,
  6,
  "USDC",
  "USD Coin",
);
const TOSHI_TOKEN = new sdkCore.Token(8453, TOSHI_BASE, 18, "TOSHI", "Toshi");

// ─── Types ──────────────────────────────────────────────────────────────────

type Call = { target: Address; data: Hex; value: bigint };
type Bucket = { routeHash: Hex; rewardAmount: bigint };
type Reward = {
  deadline: bigint;
  creator: Address;
  prover: Address;
  nativeAmount: bigint;
  tokens: { token: Address; amount: bigint }[];
};
// The Route struct on destination; abi.encode(Route) == the `route` bytes.
type RouteStruct = {
  salt: Hex;
  deadline: bigint;
  portal: Address;
  nativeAmount: bigint;
  tokens: { token: Address; amount: bigint }[];
  calls: Call[];
};
type BucketEntry = {
  route: Hex;
  routeStruct: RouteStruct;
  reward: Reward;
  bucket: Bucket;
  // Quote metadata — kept per bucket so we can report real vs. expected
  // slippage of the destination USDC→TOSHI swap after fulfillment.
  routeAmount: bigint; // 6-dec Base USDC delivered on fulfill
  toshiQuote: bigint; // expected TOSHI out at bucket-build time
  toshiMinOut: bigint; // 1%-slippage floor, enforced by the router
};

// ─── Quote + slippage helpers ───────────────────────────────────────────────

async function quoteExactInputSingle(
  client: PublicClient,
  quoter: Address,
  tokenIn: Token,
  tokenOut: Token,
  amountIn: bigint,
  fee: FeeAmount,
): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: tokenIn.address as Address,
        tokenOut: tokenOut.address as Address,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result[0]; // amountOut
}

function applySlippage(amount: bigint, slippage: Percent): bigint {
  // amount * (1 - slippage). Percent stores num/denom; use bigint math.
  const num = BigInt(slippage.numerator.toString());
  const den = BigInt(slippage.denominator.toString());
  return (amount * (den - num)) / den;
}

/**
 * Source-side reward → destination-side route amount.
 *   1. Scalar fee:      afterScalar = reward * (1 - FEE_BPS)
 *   2. Flat fee:        afterFlat   = afterScalar - FLAT_FEE_SOURCE
 *   3. Decimal scaling: 18-dec source → 6-dec destination
 */
function calculateRouteAmount(rewardAmountSource: bigint): bigint {
  const afterScalar = (rewardAmountSource * FEE_NUMERATOR) / FEE_DENOMINATOR;
  if (afterScalar <= FLAT_FEE_SOURCE) {
    throw new Error(
      `Bucket reward ${rewardAmountSource} too small to cover flat fee ${FLAT_FEE_SOURCE}`,
    );
  }
  const afterFlat = afterScalar - FLAT_FEE_SOURCE;
  const srcDec = USDC_BSC_TOKEN.decimals;
  const dstDec = USDC_BASE_TOKEN.decimals;
  if (srcDec > dstDec) return afterFlat / 10n ** BigInt(srcDec - dstDec);
  if (dstDec > srcDec) return afterFlat * 10n ** BigInt(dstDec - srcDec);
  return afterFlat;
}

// ─── Uniswap V3 single-pool approve + swap call builder ────────────────────
// Produces the `[approve, exactInputSingle]` Call[] used both source-side
// (the DEX call the gateway runs) and destination-side (the Route calls the
// Inbox runs). The two call sites differ only in addresses + recipient.

type ApproveAndSwapParams = {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: FeeAmount;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
};

function buildApproveAndSwap(p: ApproveAndSwapParams): Call[] {
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [p.router, p.amountIn],
  });
  const swapData = encodeFunctionData({
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
  });
  return [
    { target: p.tokenIn, data: approveData, value: 0n },
    { target: p.router, data: swapData, value: 0n },
  ];
}

// Destination route calls: Inbox pays USDC, receives TOSHI for the user.
function buildDestinationCalls(
  user: Address,
  routeAmount: bigint,
  toshiMinOut: bigint,
): Call[] {
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

function buildRoute(
  routeAmount: bigint,
  calls: Call[],
  routeDeadline: bigint,
): { route: Hex; routeStruct: RouteStruct } {
  const salt = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;
  const routeStruct: RouteStruct = {
    salt,
    deadline: routeDeadline,
    portal: PORTAL_BASE,
    nativeAmount: 0n,
    tokens: [{ token: USDC_BASE, amount: routeAmount }],
    calls,
  };
  const route = encodeAbiParameters([EVMRouteAbiItem], [routeStruct]);
  return { route, routeStruct };
}

// ─── Bucket construction ────────────────────────────────────────────────────

async function buildBucketEntries(
  baseClient: PublicClient,
  user: Address,
  centerUsdcSource: bigint, // 18-dec on BSC
  baseReward: Omit<Reward, "tokens">,
  routeDeadline: bigint,
): Promise<BucketEntry[]> {
  const minReward = (centerUsdcSource * (10_000n - BAND_BPS)) / 10_000n;
  const maxReward = (centerUsdcSource * (10_000n + BAND_BPS)) / 10_000n;

  const entries: BucketEntry[] = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    // Source-side reward (18-dec on BSC) — what the solver earns.
    const rewardAmount =
      minReward +
      ((maxReward - minReward) * BigInt(i)) / BigInt(NUM_BUCKETS - 1);

    // Destination-side delivery amount (6-dec on Base) — what the Inbox swaps.
    // Applies the scalar + flat fee and rescales decimals.
    const routeAmount = calculateRouteAmount(rewardAmount);

    // Live-quote USDC → TOSHI on Base at the *route* amount (what will actually
    // flow through the router), then take a 1% slippage floor.
    const toshiQuote = await quoteExactInputSingle(
      baseClient,
      QUOTER_V2_BASE,
      USDC_BASE_TOKEN,
      TOSHI_TOKEN,
      routeAmount,
      USDC_TOSHI_FEE,
    );
    const toshiMinOut = applySlippage(toshiQuote, SLIPPAGE_TOLERANCE);

    const calls = buildDestinationCalls(user, routeAmount, toshiMinOut);
    const { route, routeStruct } = buildRoute(
      routeAmount,
      calls,
      routeDeadline,
    );
    const reward: Reward = {
      ...baseReward,
      tokens: [{ token: USDC_BSC, amount: rewardAmount }],
    };

    entries.push({
      route,
      routeStruct,
      reward,
      bucket: { routeHash: keccak256(route), rewardAmount },
      routeAmount,
      toshiQuote,
      toshiMinOut,
    });
  }
  return entries;
}

// ─── Post-publish: emit IntentPublished only for the selected bucket ────────

async function publishSelected(
  walletClient: WalletClient,
  publicClient: PublicClient,
  portal: Address,
  destination: bigint,
  entry: BucketEntry,
) {
  console.log(
    `Publishing selected intent (routeHash=${entry.bucket.routeHash})…`,
  );
  const txHash = await walletClient.writeContract({
    address: portal,
    abi: portalAbi,
    functionName: "publish",
    args: [destination, entry.route, entry.reward],
    account: walletClient.account!,
    chain: walletClient.chain!,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`  publish tx: ${txHash}`);
}

// ─── Destination-chain fulfillment ──────────────────────────────────────────
// Acts as the solver: transfer routeAmount USDC to the Portal, which forwards
// to the Executor and runs the route's calls (approve router + swap to TOSHI).

// rewardHash = keccak256(abi.encode(reward)) — uses the same Reward tuple
// the Portal exposes in its ABI, so the encoding can never drift.
function computeRewardHash(reward: Reward): Hex {
  return keccak256(encodeAbiParameters([EVMRewardAbiItem], [reward]));
}

async function fulfillOnDestination(
  baseWallet: WalletClient,
  basePublic: PublicClient,
  portal: Address,
  intentHash: Hex,
  entry: BucketEntry,
  claimant: Address,
): Promise<bigint> {
  const rewardHash = computeRewardHash(entry.reward);
  console.log(
    `Fulfilling on Base (approving ${entry.routeAmount} USDC to Portal)…`,
  );

  // 1. Solver approves Portal to pull routeAmount USDC.
  const approveHash = await baseWallet.writeContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "approve",
    args: [portal, entry.routeAmount],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
  });
  await basePublic.waitForTransactionReceipt({ hash: approveHash });

  // 2. Portal.fulfill → Inbox transfers USDC, Executor runs the route's calls.
  //    Alchemy's eth_estimateGas chokes on fulfill's nested-bytes[] return and
  //    returns a spurious "-32602 Invalid params" for a tx that would actually
  //    succeed (verified via Tenderly: ~287k gas_used). We pass `gas` directly
  //    to bypass estimation and 600k covers the real cost with headroom.
  const fulfillHash = await baseWallet.writeContract({
    address: portal,
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

  // 3. Measure delivery by summing TOSHI Transfer events in *this* receipt
  //    whose `to` matches the claimant. Parsing the receipt is the source of
  //    truth — no read-after-write race against RPC replicas that may still
  //    serve pre-tx state, no dependency on "latest" caching.
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

// ─── Source-side DOGE → USDC swap on BSC ────────────────────────────────────
// Output lands with the gateway (not the user) because the gateway measures
// balanceOf(self) as the authoritative `swapOutput` for bucket selection.

function buildSourceSwapCalls(
  gateway: Address,
  dogeAmount: bigint,
  usdcMinOut: bigint,
): Call[] {
  return buildApproveAndSwap({
    router: UNISWAP_V3_ROUTER_BSC,
    tokenIn: DOGE_BSC,
    tokenOut: USDC_BSC,
    fee: DOGE_USDC_FEE,
    recipient: gateway,
    amountIn: dogeAmount,
    amountOutMinimum: usdcMinOut,
  });
}

// ─── Main orchestration ─────────────────────────────────────────────────────
// Each phase below is one self-contained step in the end-to-end flow. The
// dependencies between phases are explicit in the function signatures, which
// makes main() easy to scan and future phases easy to add/remove/reorder.

const BUCKETS_ABI_TUPLE = {
  type: "tuple[]",
  components: [
    { name: "routeHash", type: "bytes32" },
    { name: "rewardAmount", type: "uint256" },
  ],
} as const;

type Config = {
  privateKey: Hex;
  gateway: Address;
  portalBsc: Address;
  bscRpc: string;
  baseRpc: string;
};

function loadConfig(): Config {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var is required");
  const gateway = process.env.ECO_SWAP_GATEWAY_ADDRESS as Address | undefined;
  if (!gateway) throw new Error("ECO_SWAP_GATEWAY_ADDRESS env var is required");
  const portalBsc = process.env.PORTAL_BSC as Address | undefined;
  if (!portalBsc) throw new Error("PORTAL_BSC env var is required");
  return {
    privateKey: privateKey as Hex,
    gateway,
    portalBsc,
    bscRpc: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
    baseRpc: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  };
}

type Clients = {
  account: ReturnType<typeof privateKeyToAccount>;
  bscWallet: WalletClient;
  baseWallet: WalletClient;
  bscPublic: PublicClient;
  basePublic: PublicClient;
};

function createClients(config: Config): Clients {
  const account = privateKeyToAccount(config.privateKey);
  return {
    account,
    bscWallet: createWalletClient({
      account,
      chain: bsc,
      transport: http(config.bscRpc),
    }),
    // Same key acts as the solver on destination — needs Base USDC (delivery)
    // and Base ETH (gas). No cross-key coordination required for testing.
    baseWallet: createWalletClient({
      account,
      chain: base,
      transport: http(config.baseRpc),
    }),
    // Public clients are unbound from a specific chain so the structural types
    // unify cleanly — reads only (quoting + receipts).
    bscPublic: createPublicClient({ transport: http(config.bscRpc) }),
    basePublic: createPublicClient({ transport: http(config.baseRpc) }),
  };
}

async function quoteSourceSwap(bscPublic: PublicClient, inputAmount: bigint) {
  console.log("Quoting DOGE → USDC on BSC…");
  const usdcCentral = await quoteExactInputSingle(
    bscPublic,
    QUOTER_V2_BSC,
    DOGE_TOKEN,
    USDC_BSC_TOKEN,
    inputAmount,
    DOGE_USDC_FEE,
  );
  const usdcMinOut = applySlippage(usdcCentral, SLIPPAGE_TOLERANCE);
  console.log(`  central quote: ${usdcCentral} (USDC 18-dec)`);
  console.log(
    `  minOut @${SLIPPAGE_TOLERANCE.toFixed(2)}% slip: ${usdcMinOut}`,
  );
  console.log();
  return { usdcCentral, usdcMinOut };
}

async function approveGateway(
  bscWallet: WalletClient,
  bscPublic: PublicClient,
  gateway: Address,
  inputAmount: bigint,
) {
  console.log("Approving gateway to spend DOGE…");
  const txHash = await bscWallet.writeContract({
    address: DOGE_BSC,
    abi: erc20Abi,
    functionName: "approve",
    args: [gateway, inputAmount],
    account: bscWallet.account!,
    chain: bscWallet.chain!,
  });
  await bscPublic.waitForTransactionReceipt({ hash: txHash });
}

async function executeSwapAndSelect(
  clients: Clients,
  gateway: Address,
  inputAmount: bigint,
  usdcMinOut: bigint,
  baseReward: Omit<Reward, "tokens">,
  buckets: Bucket[],
): Promise<{
  intentHash: Hex;
  swapOutput: bigint;
  bucketIndex: bigint;
  bucketsHash: Hex;
}> {
  console.log("Executing swapAndSelectIntent…");
  const baseRewardForCall: Reward = {
    ...baseReward,
    tokens: [{ token: USDC_BSC, amount: 0n }], // placeholder; helper fills per bucket
  };
  const txHash = await clients.bscWallet.writeContract({
    address: gateway,
    abi: ecoSwapGatewayAbi,
    functionName: "swapAndSelectIntent",
    args: [
      DOGE_BSC,
      inputAmount,
      USDC_BSC,
      buildSourceSwapCalls(gateway, inputAmount, usdcMinOut),
      BASE_CHAIN_ID,
      baseRewardForCall,
      buckets,
      clients.account.address,
    ],
    account: clients.bscWallet.account!,
    chain: clients.bscWallet.chain!,
  });
  console.log(`  tx: ${txHash}`);

  const receipt = await clients.bscPublic.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log(`  status: ${receipt.status}`);

  const [selected] = parseEventLogs({
    abi: ecoSwapGatewayAbi,
    eventName: "IntentSelected",
    strict: true,
    logs: receipt.logs,
  });
  if (!selected) {
    throw new Error(
      "IntentSelected event not found in receipt — cannot determine which bucket to publish",
    );
  }

  const { intentHash, swapOutput, bucketIndex, rewardAmount, bucketsHash } =
    selected.args;
  console.log();
  console.log("Intent selected!");
  console.log(`  intentHash:    ${intentHash}`);
  console.log(`  swapOutput:    ${swapOutput} (USDC 18-dec)`);
  console.log(`  bucketIndex:   ${bucketIndex}`);
  console.log(`  rewardAmount:  ${rewardAmount}`);
  console.log(`  bucketsHash:   ${bucketsHash}`);
  console.log();

  return { intentHash, swapOutput, bucketIndex, bucketsHash };
}

/**
 * Verifies the contract saw the same bucket array we sent, then returns the
 * local entry that matches the selected index.
 *
 * The check compares `keccak256(abi.encode(buckets))` (what we'd expect on
 * on-chain encoding) against the `bucketsHash` emitted by the contract.
 * A mismatch would indicate the bucket array we're holding has drifted from
 * the one the gateway actually selected against (e.g. ABI encoding bug, race
 * condition), and we must NOT publish a stale route.
 */
function resolveSelectedEntry(
  entries: BucketEntry[],
  bucketIndex: bigint,
  eventBucketsHash: Hex,
): BucketEntry {
  const localBuckets = entries.map((e) => e.bucket);
  const localBucketsHash = keccak256(
    encodeAbiParameters([BUCKETS_ABI_TUPLE], [localBuckets]),
  );
  if (localBucketsHash !== eventBucketsHash) {
    throw new Error(
      `bucketsHash mismatch: contract=${eventBucketsHash} local=${localBucketsHash}`,
    );
  }
  const idx = Number(bucketIndex);
  if (idx < 0 || idx >= entries.length) {
    throw new Error(
      `bucketIndex ${bucketIndex} out of range [0, ${entries.length})`,
    );
  }
  return entries[idx];
}

function logHeader(clients: Clients, config: Config) {
  console.log(`Account:         ${clients.account.address}`);
  console.log(`EcoSwapGateway:  ${config.gateway}`);
  console.log(`Portal (BSC):    ${config.portalBsc}`);
  console.log(`Input:           ${DOGE_INPUT_HUMAN} DOGE`);
  console.log();
}

function logBuckets(entries: BucketEntry[]) {
  for (const [i, e] of entries.entries()) {
    console.log(
      `  [${i}] reward(src,18d)=${e.bucket.rewardAmount}  route(dst,6d)=${e.routeAmount}  routeHash=${e.bucket.routeHash}`,
    );
  }
  console.log();
}

async function main() {
  const config = loadConfig();
  const clients = createClients(config);

  const inputAmount = parseUnits(DOGE_INPUT_HUMAN, DOGE_TOKEN.decimals);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const routeDeadline = now + ROUTE_TTL_SECONDS;
  const rewardDeadline = now + REWARD_TTL_SECONDS;

  logHeader(clients, config);

  // 1. Live quote for the source swap → derives amountOutMinimum.
  const { usdcCentral, usdcMinOut } = await quoteSourceSwap(
    clients.bscPublic,
    inputAmount,
  );

  // 2. Build N buckets around the central USDC quote; each bucket's destination
  //    route carries a fresh USDC → TOSHI quote with tight amountOutMinimum.
  console.log(
    `Building ${NUM_BUCKETS} buckets ±${BAND_BPS}bps around center (fee: ${FEE_BPS}bps scalar + ${FLAT_FEE_SOURCE} flat)…`,
  );
  const baseReward: Omit<Reward, "tokens"> = {
    deadline: rewardDeadline,
    creator: clients.account.address,
    prover: PROVER,
    nativeAmount: 0n,
  };
  const entries = await buildBucketEntries(
    clients.basePublic,
    clients.account.address,
    usdcCentral,
    baseReward,
    routeDeadline,
  );
  logBuckets(entries);

  // 3. Approve gateway to pull DOGE.
  await approveGateway(
    clients.bscWallet,
    clients.bscPublic,
    config.gateway,
    inputAmount,
  );

  // 4. Call swapAndSelectIntent.
  const buckets = entries.map((e) => e.bucket);
  const selection = await executeSwapAndSelect(
    clients,
    config.gateway,
    inputAmount,
    usdcMinOut,
    baseReward,
    buckets,
  );

  // Source-swap slippage report (quoted vs. actual swapOutput the gateway measured).
  logSwapSlippage("Source swap (DOGE→USDC on BSC)", {
    expectedOut: usdcCentral,
    minOut: usdcMinOut,
    actualOut: selection.swapOutput,
    decimals: USDC_BSC_TOKEN.decimals,
    symbol: USDC_BSC_TOKEN.symbol!,
  });
  console.log();

  // 5. Post-publish the selected bucket. Verifies bucketsHash integrity before
  //    emitting the event — a mismatch means the local array diverged from what
  //    the contract selected against.
  const selectedEntry = resolveSelectedEntry(
    entries,
    selection.bucketIndex,
    selection.bucketsHash,
  );
  await publishSelected(
    clients.bscWallet,
    clients.bscPublic,
    config.portalBsc,
    BASE_CHAIN_ID,
    selectedEntry,
  );
  console.log();

  // 6. Act as the solver on Base: pay routeAmount USDC, let the Portal run
  //    the route's calls, and capture how much TOSHI actually arrived.
  const toshiDelivered = await fulfillOnDestination(
    clients.baseWallet,
    clients.basePublic,
    PORTAL_BASE,
    selection.intentHash,
    selectedEntry,
    clients.account.address,
  );
  console.log(`  TOSHI delivered: ${toshiDelivered}`);
  console.log();

  logSwapSlippage("Destination swap (USDC→TOSHI on Base)", {
    expectedOut: selectedEntry.toshiQuote,
    minOut: selectedEntry.toshiMinOut,
    actualOut: toshiDelivered,
    decimals: TOSHI_TOKEN.decimals,
    symbol: TOSHI_TOKEN.symbol!,
  });
}

/**
 * Compact slippage report: quoted vs. minOut floor vs. actual.
 *   quoted:  what the Quoter said at build-time
 *   minOut:  1%-slip floor that the router enforces (config slippage budget)
 *   actual:  what the swap/fulfill actually delivered
 *   real:    (quoted − actual) / quoted × 100
 */
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
  console.log(`${label}`);
  console.log(`  quoted:  ${expectedOut} (${human(expectedOut)} ${symbol})`);
  console.log(
    `  minOut:  ${minOut}   (${human(minOut)} ${symbol}) [config ${configBps}bps]`,
  );
  console.log(`  actual:  ${actualOut}   (${human(actualOut)} ${symbol})`);
  console.log(
    `  real slippage: ${realBps}bps (${(Number(realBps) / 100).toFixed(2)}%)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
