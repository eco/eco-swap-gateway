import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { FeeAmount } from "@uniswap/v3-sdk";
import type { Percent } from "@uniswap/sdk-core";
import { EVMRouteAbiItem } from "../../abi/portal.js";
import { quoterV2Abi } from "../../abi/quoterV2.js";
import { uniswapV3RouterAbi } from "../../abi/uniswapV3Router.js";
import {
  PORTAL_BASE,
  QUOTER_V2_BASE,
  SWAP_ROUTER_02_BASE,
  TOSHI_BASE,
  USDC_BASE,
  USDC_TOSHI_FEE,
} from "../config.js";
import type { EVMCall, EVMRouteStruct } from "../types.js";
import { randomSalt } from "../util/hex.js";

export function applySlippage(amount: bigint, slippage: Percent): bigint {
  const num = BigInt(slippage.numerator.toString());
  const den = BigInt(slippage.denominator.toString());
  return (amount * (den - num)) / den;
}

export async function quoteUsdcToToshi(
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

function approveAndSwap(p: {
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

/**
 * Build the EVM Route for a single bucket — a 2-call sequence (approve
 * router, swapExactInputSingle) that the Inbox runs during `fulfill`.
 */
export function buildDestinationRoute(params: {
  user: Address;
  routeAmount: bigint;
  toshiMinOut: bigint;
  routeDeadline: bigint;
}): { routeBytes: Hex; routeStruct: EVMRouteStruct } {
  const calls = approveAndSwap({
    router: SWAP_ROUTER_02_BASE,
    tokenIn: USDC_BASE,
    tokenOut: TOSHI_BASE,
    fee: USDC_TOSHI_FEE,
    recipient: params.user,
    amountIn: params.routeAmount,
    amountOutMinimum: params.toshiMinOut,
  });
  const salt = ("0x" + Buffer.from(randomSalt()).toString("hex")) as Hex;
  const routeStruct: EVMRouteStruct = {
    salt,
    deadline: params.routeDeadline,
    portal: PORTAL_BASE,
    nativeAmount: 0n,
    tokens: [{ token: USDC_BASE, amount: params.routeAmount }],
    calls,
  };
  const routeBytes = encodeAbiParameters([EVMRouteAbiItem], [routeStruct]);
  return { routeBytes, routeStruct };
}
