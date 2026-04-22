/**
 * EcoSwapGateway Example: BNB (native) on BSC → ETH on Base
 *
 * Demonstrates native-ETH input using the `inputAmount = 0` + `msg.value` flow:
 *   1. User sends BNB with msg.value — no ERC20 approval needed
 *   2. Swap calls wrap BNB → WBNB, then swap WBNB → USDC via Uniswap V3
 *   3. USDC is locked as the intent reward on BSC
 *   4. Route template delivers USDC on Base and swaps it to WETH for the user
 *      via Uniswap V3 (approve + exactInputSingle)
 *   5. The on-chain fee model applies a percentage + flat fee and converts
 *      USDC 18-dec (BSC) → USDC 6-dec (Base)
 *
 * Usage:
 *   PRIVATE_KEY=0x... ECO_SWAP_GATEWAY_ADDRESS=0x... npx tsx evm/script/swapAndCreateIntent_BNB_ETH.ts
 */

import "dotenv/config";
import crypto from "node:crypto";
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  maxUint256,
  parseEther,
  parseEventLogs,
  parseUnits,
  type Hex,
  type Address,
  padHex,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { ecoSwapGatewayAbi } from "./abi/ecoSwapGateway.js";
import { uniswapV3RouterAbi } from "./abi/uniswapV3Router.js";
import { wbnbAbi } from "./abi/wbnb.js";
import { EVMRouteAbiItem } from "./abi/portal.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const BNB_AMOUNT = process.env.BNB_AMOUNT ?? "0.01"; // default 0.01 BNB

// ─── Constants ──────────────────────────────────────────────────────────────

// BSC addresses
const WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDC_BSC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const UNISWAP_V3_ROUTER_BSC: Address =
  "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2";
const PROVER: Address = "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";
const WBNB_USDC_FEE = 500; // 0.05% — standard tier for major pairs

// Base addresses (destination chain)
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER_02_BASE: Address =
  "0x2626664c2603336E57B271c5C0b26F421741e481";
const PORTAL_BASE: Address = "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
const BASE_CHAIN_ID = 8453n;
const USDC_WETH_FEE = 500; // 0.05%

// Fee parameters — same-asset USDC model with decimal conversion (18→6).
const FEE_BPS = 6n;
const FEE_DENOMINATOR = 10000n;
const FEE_NUMERATOR = FEE_DENOMINATOR - FEE_BPS;
const FLAT_FEE = parseUnits("0.01", 18); // $0.01 — USDC on BSC is 18 decimals

// ─── Route Template Builder ─────────────────────────────────────────────────

/**
 * Build an ABI-encoded route template that delivers USDC on Base, then
 * swaps it to WETH for the recipient via Uniswap V3.
 *
 * The route's calls are:
 *   [0] USDC.approve(SwapRouter02, MAX)  — max-approve avoids a 3rd patch slot
 *   [1] SwapRouter02.exactInputSingle(USDC → WETH, recipient)
 *
 * MARKER appears in two places (matching the contract's 2-offset patching):
 *   1. tokens[0].amount  — how much USDC the Portal pulls from the solver
 *   2. exactInputSingle.amountIn — how much USDC the router swaps
 */
function buildRouteTemplate(recipient: Address): {
  routeTemplate: Hex;
  tokensAmountOffset: number;
  calldataAmountOffset: number;
} {
  const MARKER = BigInt(
    "0xDEAD00000000000000000000000000000000000000000000000000000000BEEF",
  );
  const markerHex = padHex(`0x${MARKER.toString(16)}`, {
    size: 32,
  }).toLowerCase();

  const routeDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const salt = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;

  // Call 0: approve router to spend USDC (max — no patching needed)
  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [SWAP_ROUTER_02_BASE, maxUint256],
  });

  // Call 1: swap USDC → WETH for the recipient (amountIn = MARKER)
  const swapCalldata = encodeFunctionData({
    abi: uniswapV3RouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC_BASE,
        tokenOut: WETH_BASE,
        fee: USDC_WETH_FEE,
        recipient,
        amountIn: MARKER,
        amountOutMinimum: 0n, // solver controls execution timing; see note below
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const route = {
    salt,
    deadline: routeDeadline,
    portal: PORTAL_BASE,
    nativeAmount: 0n,
    tokens: [{ token: USDC_BASE, amount: MARKER }],
    calls: [
      { target: USDC_BASE, data: approveCalldata, value: 0n },
      { target: SWAP_ROUTER_02_BASE, data: swapCalldata, value: 0n },
    ],
  };

  const encoded = encodeAbiParameters([EVMRouteAbiItem], [route]);

  const hex = encoded.slice(2).toLowerCase();
  const markerNeedle = markerHex.slice(2);

  const firstPos = hex.indexOf(markerNeedle);
  if (firstPos === -1) {
    throw new Error("Could not find MARKER in encoded route (tokens.amount)");
  }
  const tokensAmountOffset = firstPos / 2;

  const secondPos = hex.indexOf(markerNeedle, firstPos + 1);
  if (secondPos === -1) {
    throw new Error("Could not find MARKER in encoded route (swap amountIn)");
  }
  const calldataAmountOffset = secondPos / 2;

  // Verify no unexpected third occurrence
  const thirdPos = hex.indexOf(markerNeedle, secondPos + 1);
  if (thirdPos !== -1) {
    throw new Error(
      `Found unexpected 3rd MARKER at byte ${thirdPos / 2} — route has more fields to patch than the contract supports`,
    );
  }

  const zeroWord = "0".repeat(64);
  const routeTemplate = (
    "0x" + hex.replaceAll(markerNeedle, zeroWord)
  ).toLowerCase() as Hex;

  return { routeTemplate, tokensAmountOffset, calldataAmountOffset };
}

// ─── Swap Calls Builder ─────────────────────────────────────────────────────

/**
 * Build the Call[] array for a native BNB → USDC swap:
 *   [0] WBNB.deposit{value: bnbAmount}  — wrap BNB to WBNB
 *   [1] WBNB.approve(router, bnbAmount) — approve router to spend WBNB
 *   [2] router.exactInputSingle: WBNB → USDC
 */
function buildSwapCalls(
  gatewayAddress: Address,
  bnbAmount: bigint,
  minOutputAmount: bigint,
): Array<{ target: Address; data: Hex; value: bigint }> {
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
        recipient: gatewayAddress,
        amountIn: bnbAmount,
        amountOutMinimum: minOutputAmount,
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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY env var is required");
  }
  const gatewayAddress = process.env.ECO_SWAP_GATEWAY_ADDRESS as
    | Address
    | undefined;
  if (!gatewayAddress) {
    throw new Error("ECO_SWAP_GATEWAY_ADDRESS env var is required");
  }

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

  const bnbAmount = parseEther(BNB_AMOUNT);
  const minOutputAmount = 0n;
  const rewardDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);

  console.log(`Account:          ${account.address}`);
  console.log(`EcoSwapGateway:   ${gatewayAddress}`);
  console.log(`Input:            ${BNB_AMOUNT} BNB (native)`);
  console.log(`Swap:             BNB → WBNB → USDC on BSC (Uniswap V3)`);
  console.log(`Intent:           USDC (BSC) → USDC (Base) → WETH (Base)`);
  console.log();

  // 1. Build route template (destination: deliver USDC, swap to WETH)
  const { routeTemplate, tokensAmountOffset, calldataAmountOffset } =
    buildRouteTemplate(account.address);

  console.log(`Route template:          ${routeTemplate.length / 2 - 1} bytes`);
  console.log(`tokensAmountOffset:      ${tokensAmountOffset}`);
  console.log(`calldataAmountOffset:    ${calldataAmountOffset}`);
  console.log();

  // 2. Build swap calls (wrap BNB → WBNB, then swap WBNB → USDC)
  const swapCalls = buildSwapCalls(gatewayAddress, bnbAmount, minOutputAmount);

  // 3. No ERC20 approval needed — BNB is sent as msg.value

  // 4. Execute swapAndCreateIntent with native BNB
  console.log("Executing swapAndCreateIntent (native BNB input)...");
  const txHash = await walletClient.writeContract({
    address: gatewayAddress,
    abi: ecoSwapGatewayAbi,
    functionName: "swapAndCreateIntent",
    args: [
      WBNB, // inputToken: valid ERC20 for cleanup (no tokens pulled)
      0n, // inputAmount: 0 — native BNB sent via msg.value
      USDC_BSC,
      swapCalls,
      {
        destination: BASE_CHAIN_ID,
        routeTemplate,
        tokensAmountOffset,
        calldataAmountOffset,
        rewardDeadline,
        rewardCreator: account.address,
        rewardProver: PROVER,
        flatFee: FLAT_FEE,
        feeNumerator: FEE_NUMERATOR,
        feeDenominator: FEE_DENOMINATOR,
        sourceDecimals: 18, // USDC on BSC
        destinationDecimals: 6, // USDC on Base
        allowPartial: false,
        routeType: 0, // EVM
      },
      account.address,
    ],
    value: bnbAmount,
  });

  console.log(`  tx: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log(`  status: ${receipt.status}`);

  // 5. Parse IntentCreated event
  const [intentEvent] = parseEventLogs({
    abi: ecoSwapGatewayAbi,
    eventName: "IntentCreated",
    strict: true,
    logs: receipt.logs,
  });

  if (intentEvent) {
    const { intentHash, swapOutput } = intentEvent.args;
    console.log();
    console.log("Intent created!");
    console.log(`  intentHash:  ${intentHash}`);
    console.log(`  swapOutput:  ${swapOutput} (USDC 18-dec)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
