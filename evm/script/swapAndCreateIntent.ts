/**
 * SwapIntent Example: PEPE → USDC on BSC, then USDC on BSC → USDC on Base
 *
 * This script demonstrates the full flow:
 *   1. Build the destination-chain route template (ERC20 transfer on Base)
 *   2. Compute byte offsets for amount patching
 *   3. Encode the swap calls (approve + Uniswap V3 exactInputSingle)
 *   4. Call SwapIntent.swapAndCreateIntent
 *
 * Usage:
 *   PRIVATE_KEY=0x... SWAP_INTENT_ADDRESS=0x... npx tsx evm/script/swapAndCreateIntent.ts
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  erc20Abi,
  type Hex,
  type Address,
  padHex,
  parseUnits,
  keccak256,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { swapIntentAbi } from "./abi/swapIntent.js";
import { uniswapV3RouterAbi } from "./abi/uniswapV3Router.js";

// ─── Constants ──────────────────────────────────────────────────────────────

// BSC addresses
const PEPE_BSC: Address = "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00";
const USDC_BSC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const UNISWAP_V3_ROUTER: Address = "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2";
const PROVER: Address = "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";

// Base addresses (destination chain)
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PORTAL_BASE: Address = "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
const BASE_CHAIN_ID = 8453n;

// Fee parameters (0.3% scalar fee, no flat fee)
const SCALAR_NUM = 997n;
const SCALAR_DENOM = 1000n;
const FLAT_FEE = 0n;

// ─── Route Template Builder ─────────────────────────────────────────────────

/**
 * ABI type for the Route struct (matches eco-routes contracts/types/Intent.sol).
 * Used to encode the route template that describes what happens on the
 * destination chain.
 */
const routeAbiType = parseAbiParameters([
  "(bytes32 salt, uint64 deadline, address portal, uint256 nativeAmount, (address token, uint256 amount)[] tokens, (address target, bytes data, uint256 value)[] calls)",
]);

/**
 * Build an ABI-encoded route template and compute the byte offsets where
 * the on-chain contract must patch the actual `routeAmount`.
 *
 * The route describes an ERC20 transfer on Base: send USDC to the recipient.
 * The amount is set to a unique MARKER so we can locate it in the encoded bytes.
 */
function buildRouteTemplate(recipient: Address): {
  routeTemplate: Hex;
  tokensAmountOffset: number;
  calldataAmountOffset: number;
} {
  // Unique marker that won't appear naturally in ABI-encoded data.
  const MARKER = BigInt(
    "0xDEAD00000000000000000000000000000000000000000000000000000000BEEF",
  );
  const markerHex = padHex(`0x${MARKER.toString(16)}`, {
    size: 32,
  }).toLowerCase();

  const routeDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const salt = keccak256(
    encodeAbiParameters(parseAbiParameters(["uint256, uint256"]), [
      0n,
      BigInt(Date.now()),
    ]),
  );

  // ERC20 transfer calldata: transfer(recipient, MARKER)
  const transferCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, MARKER],
  });

  const route = {
    salt,
    deadline: routeDeadline,
    portal: PORTAL_BASE,
    nativeAmount: 0n,
    tokens: [{ token: USDC_BASE, amount: MARKER }],
    calls: [{ target: USDC_BASE, data: transferCalldata, value: 0n }],
  };

  const encoded = encodeAbiParameters(routeAbiType, [route]);

  // Strip 0x prefix and search for the marker (as lowercase hex).
  const hex = encoded.slice(2).toLowerCase();
  const markerNeedle = markerHex.slice(2);

  const firstPos = hex.indexOf(markerNeedle);
  if (firstPos === -1) {
    throw new Error("Could not find MARKER in encoded route (tokens.amount)");
  }
  const tokensAmountOffset = firstPos / 2;

  const secondPos = hex.indexOf(markerNeedle, firstPos + 1);
  if (secondPos === -1) {
    throw new Error("Could not find MARKER in encoded route (calldata.amount)");
  }
  const calldataAmountOffset = secondPos / 2;

  // Replace markers with zero (the contract will patch them).
  const zeroWord = "0".repeat(64);
  const routeTemplate = (
    "0x" + hex.replaceAll(markerNeedle, zeroWord)
  ).toLowerCase() as Hex;

  return { routeTemplate, tokensAmountOffset, calldataAmountOffset };
}

// ─── Swap Calls Builder ─────────────────────────────────────────────────────

/**
 * Build the Call[] array that SwapIntent will execute:
 *   [0] approve Uniswap router to spend PEPE
 *   [1] Uniswap V3 exactInputSingle: PEPE → USDC
 */
function buildSwapCalls(
  swapIntentAddress: Address,
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
        fee: 3000, // 0.3% pool
        recipient: swapIntentAddress, // output goes to SwapIntent
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
  if (!privateKey) {
    throw new Error("PRIVATE_KEY env var is required");
  }
  const swapIntentAddress = process.env.SWAP_INTENT_ADDRESS as
    | Address
    | undefined;
  if (!swapIntentAddress) {
    throw new Error("SWAP_INTENT_ADDRESS env var is required");
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

  // --- Parameters ---
  const inputAmount = parseUnits("1000000", 18); // 1M PEPE (18 decimals)
  const minOutputAmount = 0n; // Let the contract handle slippage via fee model
  const rewardDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200); // 2 hours

  console.log(`Account:        ${account.address}`);
  console.log(`SwapIntent:     ${swapIntentAddress}`);
  console.log(`Input:          1,000,000 PEPE`);
  console.log(`Swap:           PEPE → USDC on BSC (Uniswap V3)`);
  console.log(`Intent:         USDC on BSC → USDC on Base`);
  console.log();

  // 1. Build route template (destination chain: Base)
  const { routeTemplate, tokensAmountOffset, calldataAmountOffset } =
    buildRouteTemplate(account.address);

  console.log(`Route template:          ${routeTemplate.length / 2 - 1} bytes`);
  console.log(`tokensAmountOffset:      ${tokensAmountOffset}`);
  console.log(`calldataAmountOffset:    ${calldataAmountOffset}`);
  console.log();

  // 2. Build swap calls
  const calls = buildSwapCalls(swapIntentAddress, inputAmount, minOutputAmount);

  // 3. Approve SwapIntent to pull PEPE
  console.log("Approving SwapIntent to spend PEPE...");
  const approveHash = await walletClient.writeContract({
    address: PEPE_BSC,
    abi: erc20Abi,
    functionName: "approve",
    args: [swapIntentAddress, inputAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  tx: ${approveHash}`);

  // 4. Execute swapAndCreateIntent
  console.log("Executing swapAndCreateIntent...");
  const txHash = await walletClient.writeContract({
    address: swapIntentAddress,
    abi: swapIntentAbi,
    functionName: "swapAndCreateIntent",
    args: [
      PEPE_BSC,
      inputAmount,
      USDC_BSC,
      calls,
      {
        destination: BASE_CHAIN_ID,
        routeTemplate,
        tokensAmountOffset,
        calldataAmountOffset,
        rewardDeadline,
        rewardCreator: account.address,
        rewardProver: PROVER,
        flatFee: FLAT_FEE,
        scalarNum: SCALAR_NUM,
        scalarDenom: SCALAR_DENOM,
        allowPartial: false,
      },
    ],
  });

  console.log(`  tx: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log(`  status: ${receipt.status}`);

  // 5. Parse IntentCreated event
  const intentCreatedTopic = keccak256(
    new TextEncoder().encode(
      "IntentCreated(bytes32,address,address,uint256,uint256,uint64)",
    ) as unknown as Hex,
  );

  const intentLog = receipt.logs.find(
    (log) => log.topics[0] === intentCreatedTopic,
  );

  if (intentLog) {
    const intentHash = intentLog.topics[1];
    console.log();
    console.log(`Intent created!`);
    console.log(`  intentHash: ${intentHash}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
