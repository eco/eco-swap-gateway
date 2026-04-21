/**
 * EcoSwapGateway Bucketed Example: PEPE → USDC on BSC, then USDC on BSC → USDC on Base
 *
 * Demonstrates the bucketed flow:
 *   1. Build N candidate routes + their routeHashes
 *   2. (Optional) Publish candidates via Portal.publish so solvers can index
 *      the full Route bytes via IntentPublished events
 *   3. User signs a single tx calling swapAndSelectIntent with the bucket list
 *   4. Helper floor-selects the bucket matching actual swap output and calls Portal.fund
 *   5. Surplus (swapOutput − bucket.rewardAmount) is swept to sweepRecipient
 *
 * Step 2 is NOT required by the gateway — Portal.fund derives the vault
 * deterministically from (destination, routeHash, reward) and accepts funding
 * for an unpublished intent. It is shown here because solvers still need the
 * full Route bytes to fulfill on the destination chain; pre-publishing is the
 * simplest way to expose them. In production a solver may index from a
 * different channel (API, mempool observation, IntentSelected event).
 *
 * Usage:
 *   PRIVATE_KEY=0x... ECO_SWAP_GATEWAY_ADDRESS=0x... PORTAL_BSC=0x... \
 *     npx tsx evm/script/swapAndSelectIntent.ts
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
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { ecoSwapGatewayAbi } from "./abi/ecoSwapGateway.js";
import { EVMRouteAbiItem, portalAbi } from "./abi/portal.js";
import { uniswapV3RouterAbi } from "./abi/uniswapV3Router.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const PEPE_AMOUNT = 200_000n;
const NUM_BUCKETS = 8;

// ─── Constants ──────────────────────────────────────────────────────────────

// BSC (source)
const PEPE_BSC: Address = "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00";
const USDC_BSC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const UNISWAP_V3_ROUTER: Address = "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2";
const PROVER: Address = "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";

// Base (destination)
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PORTAL_BASE: Address = "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
const BASE_CHAIN_ID = 8453n;

// Helper: expected USDC output range around the Jupiter/Uniswap quote's central estimate.
// In production, derive these from a live quote; here they're hardcoded for the demo.
const EXPECTED_OUTPUT_CENTER = parseUnits("1.0", 18); // 1 USDC on BSC (18 decimals)
const BAND_HALF_WIDTH = parseUnits("0.25", 18); // ±0.25 USDC

// ─── Bucket helpers ─────────────────────────────────────────────────────────

type Bucket = { routeHash: Hex; rewardAmount: bigint };
type BucketEntry = { route: Hex; reward: Reward; bucket: Bucket };
type Reward = {
  deadline: bigint;
  creator: Address;
  prover: Address;
  nativeAmount: bigint;
  tokens: { token: Address; amount: bigint }[];
};

function buildRouteForAmount(
  recipient: Address,
  amount: bigint,
  routeDeadline: bigint,
): Hex {
  const salt = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;
  const transferCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, amount],
  });
  return encodeAbiParameters(
    [EVMRouteAbiItem],
    [
      {
        salt,
        deadline: routeDeadline,
        portal: PORTAL_BASE,
        nativeAmount: 0n,
        tokens: [{ token: USDC_BASE, amount }],
        calls: [{ target: USDC_BASE, data: transferCalldata, value: 0n }],
      },
    ],
  );
}

/**
 * Build N buckets linearly spaced across [minOutput, maxOutput].
 * Each bucket has a distinct route (distinct salt + amount → distinct routeHash)
 * and the full Reward struct the Solver will publish with.
 */
function buildBucketEntries(
  recipient: Address,
  minOutput: bigint,
  maxOutput: bigint,
  n: number,
  baseReward: Omit<Reward, "tokens">,
  rewardToken: Address,
  routeDeadline: bigint,
): BucketEntry[] {
  if (n < 2) throw new Error("N must be >= 2");
  const entries: BucketEntry[] = [];
  for (let i = 0; i < n; i++) {
    const rewardAmount =
      minOutput + ((maxOutput - minOutput) * BigInt(i)) / BigInt(n - 1);
    const route = buildRouteForAmount(recipient, rewardAmount, routeDeadline);
    const reward: Reward = {
      ...baseReward,
      tokens: [{ token: rewardToken, amount: rewardAmount }],
    };
    entries.push({
      route,
      reward,
      bucket: { routeHash: keccak256(route), rewardAmount },
    });
  }
  return entries;
}

/**
 * Publish each bucket's intent via Portal.publish so solvers can index the
 * full Route bytes via IntentPublished events. This step is OPTIONAL — the
 * gateway's Portal.fund call works fine against unpublished intents — but
 * solvers still need the Route bytes to fulfill on the destination chain,
 * and pre-publishing is the simplest discovery channel.
 */
async function solverPrePublish(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  portal: Address,
  destination: bigint,
  entries: BucketEntry[],
) {
  console.log(
    `Solver pre-publishing ${entries.length} intents via Portal.publish...`,
  );
  for (const [i, entry] of entries.entries()) {
    const txHash = await walletClient.writeContract({
      address: portal,
      abi: portalAbi,
      functionName: "publish",
      args: [destination, entry.route, entry.reward],
      account: walletClient.account!,
      chain: walletClient.chain!,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(
      `  [${i}] reward=${entry.bucket.rewardAmount} routeHash=${entry.bucket.routeHash} tx=${txHash}`,
    );
  }
}

// ─── Swap call builder (identical to the non-bucketed script) ──────────────

function buildSwapCalls(
  gateway: Address,
  inputAmount: bigint,
  minOutputAmount: bigint,
): Array<{ target: Address; data: Hex; value: bigint }> {
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [UNISWAP_V3_ROUTER, inputAmount],
  });
  const swapData = encodeFunctionData({
    abi: uniswapV3RouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: PEPE_BSC,
        tokenOut: USDC_BSC,
        fee: 3000,
        recipient: gateway,
        amountIn: inputAmount,
        amountOutMinimum: minOutputAmount,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return [
    { target: PEPE_BSC, data: approveData, value: 0n },
    { target: UNISWAP_V3_ROUTER, data: swapData, value: 0n },
  ];
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var is required");
  const gateway = process.env.ECO_SWAP_GATEWAY_ADDRESS as Address | undefined;
  if (!gateway) throw new Error("ECO_SWAP_GATEWAY_ADDRESS env var is required");
  const portalBsc = process.env.PORTAL_BSC as Address | undefined;
  if (!portalBsc) throw new Error("PORTAL_BSC env var is required");

  const rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org";
  const account = privateKeyToAccount(privateKey as Hex);
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: bsc,
    transport: http(rpcUrl),
  });

  const inputAmount = parseUnits(PEPE_AMOUNT.toString(), 18);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const routeDeadline = now + 3600n;
  const rewardDeadline = now + 7200n;

  const minOutput = EXPECTED_OUTPUT_CENTER - BAND_HALF_WIDTH;
  const maxOutput = EXPECTED_OUTPUT_CENTER + BAND_HALF_WIDTH;

  console.log(`Account:          ${account.address}`);
  console.log(`EcoSwapGateway:   ${gateway}`);
  console.log(`Portal (BSC):     ${portalBsc}`);
  console.log(`Input:            ${PEPE_AMOUNT.toLocaleString()} PEPE`);
  console.log(
    `Reward range:     [${minOutput}, ${maxOutput}] (${NUM_BUCKETS} buckets)`,
  );
  console.log();

  // 1. Build bucket entries (routes + rewards + routeHashes).
  const baseReward: Omit<Reward, "tokens"> = {
    deadline: rewardDeadline,
    creator: account.address,
    prover: PROVER,
    nativeAmount: 0n,
  };
  const entries = buildBucketEntries(
    account.address,
    minOutput,
    maxOutput,
    NUM_BUCKETS,
    baseReward,
    USDC_BSC,
    routeDeadline,
  );

  // 2. Solver-side pre-publish (in production this is done by eco-solver).
  await solverPrePublish(
    walletClient,
    publicClient,
    portalBsc,
    BASE_CHAIN_ID,
    entries,
  );
  console.log();

  // 3. Approve gateway to pull PEPE.
  console.log("Approving gateway to spend PEPE...");
  const approveHash = await walletClient.writeContract({
    address: PEPE_BSC,
    abi: erc20Abi,
    functionName: "approve",
    args: [gateway, inputAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // 4. Call swapAndSelectIntent. The helper measures swapOutput, floor-selects,
  //    and funds exactly one bucket via Portal.fund(routeHash, reward_k, ...).
  console.log("Executing swapAndSelectIntent...");
  const buckets = entries.map((e) => e.bucket);
  const baseRewardForCall: Reward = {
    ...baseReward,
    tokens: [{ token: USDC_BSC, amount: 0n }], // placeholder; helper fills in per bucket
  };

  const txHash = await walletClient.writeContract({
    address: gateway,
    abi: ecoSwapGatewayAbi,
    functionName: "swapAndSelectIntent",
    args: [
      PEPE_BSC,
      inputAmount,
      USDC_BSC,
      buildSwapCalls(gateway, inputAmount, 0n),
      BASE_CHAIN_ID,
      baseRewardForCall,
      buckets,
      account.address, // sweepRecipient
    ],
  });
  console.log(`  tx: ${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log(`  status: ${receipt.status}`);

  // 5. Parse IntentSelected to learn which bucket was chosen.
  const [selected] = parseEventLogs({
    abi: ecoSwapGatewayAbi,
    eventName: "IntentSelected",
    strict: true,
    logs: receipt.logs,
  });

  if (selected) {
    const { intentHash, swapOutput, bucketIndex, rewardAmount, bucketsHash } =
      selected.args;
    console.log();
    console.log("Intent selected!");
    console.log(`  intentHash:    ${intentHash}`);
    console.log(`  swapOutput:    ${swapOutput}`);
    console.log(`  bucketIndex:   ${bucketIndex}`);
    console.log(`  rewardAmount:  ${rewardAmount}`);
    console.log(`  bucketsHash:   ${bucketsHash}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
