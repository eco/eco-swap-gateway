/**
 * EcoSwapGateway Bucketed Example: BNB (native) on BSC → ETH on Base
 *
 * End-to-end flow:
 *   1. User sends native BNB — no ERC20 approval needed.
 *   2. Gateway wraps BNB → WBNB, swaps WBNB → USDC on BSC (Uniswap V3).
 *   3. Gateway funds one bucketed intent via Portal.fund. Each bucket's
 *      destination Route delivers USDC on Base, then swaps it to WETH
 *      for the user via Uniswap V3 (approve + exactInputSingle).
 *   4. After IntentSelected, we publish *only that* Route so solvers can
 *      discover it. Saves N-1 publishes' worth of gas.
 *   5. Solver fulfills the Route on Base, completing the cross-chain swap.
 *
 * Buckets span [usdcMinOut, usdcQuote] on the source side. Each bucket's
 * destination route carries a tight USDC → WETH amountOutMinimum derived
 * from a live quote on Base.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ECO_SWAP_GATEWAY_ADDRESS=0x... PORTAL_BSC=0x... \
 *     npm run swap-select-bnb-eth
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
  maxUint256,
  pad,
  parseEther,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { bsc, base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
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
import { wbnbAbi } from "./abi/wbnb.js";
import { quoterV2Abi } from "./abi/quoterV2.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const BNB_INPUT_HUMAN = process.env.BNB_AMOUNT ?? "0.01";
const NUM_BUCKETS = 6;
const SLIPPAGE_TOLERANCE = new sdkCore.Percent(100, 10_000); // 1%
const ROUTE_TTL_SECONDS = 3600n;
const REWARD_TTL_SECONDS = 7200n;

// Protocol fee applied off-chain per bucket to derive destination USDC
// route amounts from source USDC reward amounts.
const FEE_BPS = 6n;
const FEE_DENOMINATOR = 10_000n;
const FEE_NUMERATOR = FEE_DENOMINATOR - FEE_BPS;
const FLAT_FEE_SOURCE = parseUnits("0.01", 18); // $0.01 in USDC (18-dec BSC)

// ─── Constants ──────────────────────────────────────────────────────────────

// BSC (source)
const WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDC_BSC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const UNISWAP_V3_ROUTER_BSC: Address =
  "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2";
const QUOTER_V2_BSC: Address = "0x78D78E420Da98ad378D7799bE8f4AF69033EB077";
const WBNB_USDC_FEE: FeeAmount = v3Sdk.FeeAmount.LOW; // 500 (0.05%)
const PROVER: Address = "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";

// Base (destination)
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER_02_BASE: Address =
  "0x2626664c2603336E57B271c5C0b26F421741e481";
const QUOTER_V2_BASE: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const PORTAL_BASE: Address = "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
const USDC_WETH_FEE: FeeAmount = v3Sdk.FeeAmount.LOW; // 500 (0.05%)
const BASE_CHAIN_ID = 8453n;

// Uniswap SDK tokens
const WBNB_TOKEN = new sdkCore.Token(56, WBNB, 18, "WBNB", "Wrapped BNB");
const USDC_BSC_TOKEN = new sdkCore.Token(56, USDC_BSC, 18, "USDC", "USD Coin");
const USDC_BASE_TOKEN = new sdkCore.Token(
  8453,
  USDC_BASE,
  6,
  "USDC",
  "USD Coin",
);
const WETH_BASE_TOKEN = new sdkCore.Token(
  8453,
  WETH_BASE,
  18,
  "WETH",
  "Wrapped Ether",
);

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
  routeAmount: bigint; // USDC (6-dec Base) delivered to the Executor
  wethQuote: bigint; // expected WETH out at bucket-build time
  wethMinOut: bigint; // 1%-slippage floor enforced by the router
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
  return result[0];
}

function applySlippage(amount: bigint, slippage: Percent): bigint {
  const num = BigInt(slippage.numerator.toString());
  const den = BigInt(slippage.denominator.toString());
  return (amount * (den - num)) / den;
}

/**
 * Source-side USDC reward (18-dec BSC) → destination-side USDC (6-dec Base).
 * Applies scalar + flat fee, then rescales 18 → 6 decimals.
 */
function rewardToRouteUsdc(rewardAmountSource: bigint): bigint {
  const afterScalar = (rewardAmountSource * FEE_NUMERATOR) / FEE_DENOMINATOR;
  if (afterScalar <= FLAT_FEE_SOURCE) {
    throw new Error(
      `Bucket reward ${rewardAmountSource} too small to cover flat fee`,
    );
  }
  const afterFlat = afterScalar - FLAT_FEE_SOURCE;
  // 18-dec BSC → 6-dec Base
  return afterFlat / 10n ** 12n;
}

// ─── Swap calls ─────────────────────────────────────────────────────────────

/**
 * Source-side swap calls: wrap BNB → WBNB, then swap WBNB → USDC.
 * Output lands with the gateway (not the user) for balance measurement.
 */
function buildSourceSwapCalls(
  gateway: Address,
  bnbAmount: bigint,
  usdcMinOut: bigint,
): Call[] {
  const depositData = encodeFunctionData({
    abi: wbnbAbi,
    functionName: "deposit",
  });
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [UNISWAP_V3_ROUTER_BSC, bnbAmount],
  });
  const swapData = encodeFunctionData({
    abi: uniswapV3RouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: WBNB,
        tokenOut: USDC_BSC,
        fee: WBNB_USDC_FEE,
        recipient: gateway,
        amountIn: bnbAmount,
        amountOutMinimum: usdcMinOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return [
    { target: WBNB, data: depositData, value: bnbAmount },
    { target: WBNB, data: approveData, value: 0n },
    { target: UNISWAP_V3_ROUTER_BSC, data: swapData, value: 0n },
  ];
}

// ─── Route builder ──────────────────────────────────────────────────────────

/**
 * Build a destination route that delivers USDC on Base and swaps it to
 * WETH for the user via Uniswap V3. Route calls:
 *   [0] USDC.approve(SwapRouter02, MAX)
 *   [1] SwapRouter02.exactInputSingle(USDC → WETH, recipient = user)
 */
function buildRoute(
  user: Address,
  routeAmount: bigint,
  wethMinOut: bigint,
  routeDeadline: bigint,
): { route: Hex; routeStruct: RouteStruct } {
  const salt = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;

  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [SWAP_ROUTER_02_BASE, maxUint256],
  });
  const swapCalldata = encodeFunctionData({
    abi: uniswapV3RouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC_BASE,
        tokenOut: WETH_BASE,
        fee: USDC_WETH_FEE,
        recipient: user,
        amountIn: routeAmount,
        amountOutMinimum: wethMinOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const routeStruct: RouteStruct = {
    salt,
    deadline: routeDeadline,
    portal: PORTAL_BASE,
    nativeAmount: 0n,
    tokens: [{ token: USDC_BASE, amount: routeAmount }],
    calls: [
      { target: USDC_BASE, data: approveCalldata, value: 0n },
      { target: SWAP_ROUTER_02_BASE, data: swapCalldata, value: 0n },
    ],
  };
  const route = encodeAbiParameters([EVMRouteAbiItem], [routeStruct]);
  return { route, routeStruct };
}

// ─── Bucket construction ────────────────────────────────────────────────────

async function buildBucketEntries(
  baseClient: PublicClient,
  user: Address,
  quoteUsdcSource: bigint,
  minUsdcSource: bigint,
  baseReward: Omit<Reward, "tokens">,
  routeDeadline: bigint,
): Promise<BucketEntry[]> {
  if (minUsdcSource >= quoteUsdcSource) {
    throw new Error(
      `minUsdcSource (${minUsdcSource}) must be < quoteUsdcSource (${quoteUsdcSource})`,
    );
  }

  const entries: BucketEntry[] = [];
  for (let i = 0; i < NUM_BUCKETS; i++) {
    const rewardAmount =
      minUsdcSource +
      ((quoteUsdcSource - minUsdcSource) * BigInt(i)) / BigInt(NUM_BUCKETS - 1);

    // Fee-adjusted USDC in Base decimals (6-dec)
    const routeAmount = rewardToRouteUsdc(rewardAmount);

    // Live quote: how much WETH does routeAmount USDC buy on Base?
    const wethQuote = await quoteExactInputSingle(
      baseClient,
      QUOTER_V2_BASE,
      USDC_BASE_TOKEN,
      WETH_BASE_TOKEN,
      routeAmount,
      USDC_WETH_FEE,
    );
    const wethMinOut = applySlippage(wethQuote, SLIPPAGE_TOLERANCE);

    const { route, routeStruct } = buildRoute(
      user,
      routeAmount,
      wethMinOut,
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
      wethQuote,
      wethMinOut,
    });
  }
  return entries;
}

// ─── Post-publish + fulfillment ─────────────────────────────────────────────

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

  // 1. Solver approves Portal to pull USDC
  const approveHash = await baseWallet.writeContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "approve",
    args: [portal, entry.routeAmount],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
  });
  await basePublic.waitForTransactionReceipt({ hash: approveHash });

  // 2. Portal.fulfill → Executor receives USDC, runs route calls
  //    (approve router + swap USDC → WETH for user)
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

  // 3. Measure WETH delivered to the claimant
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receipt.logs,
  });
  let delivered = 0n;
  for (const log of transfers) {
    if (
      log.address.toLowerCase() === WETH_BASE.toLowerCase() &&
      log.args.to?.toLowerCase() === claimant.toLowerCase()
    ) {
      delivered += log.args.value ?? 0n;
    }
  }
  return delivered;
}

// ─── Orchestration helpers ──────────────────────────────────────────────────

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
    baseWallet: createWalletClient({
      account,
      chain: base,
      transport: http(config.baseRpc),
    }),
    bscPublic: createPublicClient({ transport: http(config.bscRpc) }),
    basePublic: createPublicClient({ transport: http(config.baseRpc) }),
  };
}

async function quoteSourceSwap(bscPublic: PublicClient, bnbAmount: bigint) {
  console.log("Quoting WBNB → USDC on BSC…");
  const usdcCentral = await quoteExactInputSingle(
    bscPublic,
    QUOTER_V2_BSC,
    WBNB_TOKEN,
    USDC_BSC_TOKEN,
    bnbAmount,
    WBNB_USDC_FEE,
  );
  const usdcMinOut = applySlippage(usdcCentral, SLIPPAGE_TOLERANCE);
  console.log(`  central quote: ${usdcCentral} (USDC 18-dec)`);
  console.log(
    `  minOut @${SLIPPAGE_TOLERANCE.toFixed(2)}% slip: ${usdcMinOut}`,
  );
  console.log();
  return { usdcCentral, usdcMinOut };
}

async function executeSwapAndSelect(
  clients: Clients,
  gateway: Address,
  bnbAmount: bigint,
  usdcMinOut: bigint,
  baseReward: Omit<Reward, "tokens">,
  buckets: Bucket[],
): Promise<{
  intentHash: Hex;
  swapOutput: bigint;
  bucketIndex: bigint;
  bucketsHash: Hex;
}> {
  console.log("Executing swapAndSelectIntent (native BNB input)…");
  const baseRewardForCall: Reward = {
    ...baseReward,
    tokens: [{ token: USDC_BSC, amount: 0n }],
  };
  const txHash = await clients.bscWallet.writeContract({
    address: gateway,
    abi: ecoSwapGatewayAbi,
    functionName: "swapAndSelectIntent",
    args: [
      WBNB, // inputToken: valid ERC20 for cleanup; no tokens pulled
      0n, // inputAmount: 0 — native BNB sent via msg.value
      USDC_BSC,
      buildSourceSwapCalls(gateway, bnbAmount, usdcMinOut),
      BASE_CHAIN_ID,
      baseRewardForCall,
      buckets,
      clients.account.address,
    ],
    account: clients.bscWallet.account!,
    chain: clients.bscWallet.chain!,
    value: bnbAmount,
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
    throw new Error("IntentSelected event not found in receipt");
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
  console.log(`Input:           ${BNB_INPUT_HUMAN} BNB (native)`);
  console.log(
    `Flow:            BNB → WBNB → USDC (BSC) → USDC (Base) → WETH (Base)`,
  );
  console.log();
}

function logBuckets(entries: BucketEntry[]) {
  for (const [i, e] of entries.entries()) {
    console.log(
      `  [${i}] reward(USDC,18d)=${e.bucket.rewardAmount}  route(USDC,6d)=${e.routeAmount}  wethOut≈${e.wethQuote}  routeHash=${e.bucket.routeHash}`,
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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const clients = createClients(config);

  const bnbAmount = parseEther(BNB_INPUT_HUMAN);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const routeDeadline = now + ROUTE_TTL_SECONDS;
  const rewardDeadline = now + REWARD_TTL_SECONDS;

  logHeader(clients, config);

  // 1. Quote WBNB → USDC on BSC
  const { usdcCentral, usdcMinOut } = await quoteSourceSwap(
    clients.bscPublic,
    bnbAmount,
  );

  // 2. Build N buckets spanning [minOut, quote]. Each bucket's destination
  //    route delivers USDC on Base and swaps it to WETH with a tight
  //    amountOutMinimum from a live Base quote.
  console.log(
    `Building ${NUM_BUCKETS} buckets (fee: ${FEE_BPS}bps scalar + ${FLAT_FEE_SOURCE} flat)…`,
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
    usdcMinOut,
    baseReward,
    routeDeadline,
  );
  logBuckets(entries);

  // 3. No ERC20 approval needed — BNB is sent as msg.value

  // 4. Call swapAndSelectIntent
  const buckets = entries.map((e) => e.bucket);
  const selection = await executeSwapAndSelect(
    clients,
    config.gateway,
    bnbAmount,
    usdcMinOut,
    baseReward,
    buckets,
  );

  logSwapSlippage("Source swap (WBNB→USDC on BSC)", {
    expectedOut: usdcCentral,
    minOut: usdcMinOut,
    actualOut: selection.swapOutput,
    decimals: USDC_BSC_TOKEN.decimals,
    symbol: USDC_BSC_TOKEN.symbol!,
  });
  console.log();

  // 5. Publish the selected bucket's route
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

  // 6. Act as solver on Base: deliver USDC, Executor swaps to WETH for user
  const wethDelivered = await fulfillOnDestination(
    clients.baseWallet,
    clients.basePublic,
    PORTAL_BASE,
    selection.intentHash,
    selectedEntry,
    clients.account.address,
  );
  console.log(`  WETH delivered: ${wethDelivered}`);
  console.log();

  logSwapSlippage("Destination swap (USDC→WETH on Base)", {
    expectedOut: selectedEntry.wethQuote,
    minOut: selectedEntry.wethMinOut,
    actualOut: wethDelivered,
    decimals: WETH_BASE_TOKEN.decimals,
    symbol: WETH_BASE_TOKEN.symbol!,
  });

  const humanWeth = (Number(wethDelivered) / 1e18).toFixed(8);
  console.log();
  console.log("Summary");
  console.log(`  Sent:      ${BNB_INPUT_HUMAN} BNB (native)`);
  console.log(`  Received:  ${humanWeth} WETH on Base`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
