import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createRequire } from "node:module";
import type { Address, Hex } from "viem";
import type { FeeAmount } from "@uniswap/v3-sdk";
import type { Percent, Token } from "@uniswap/sdk-core";
import { CHAIN_ID_SOLANA } from "../common.js";

// Uniswap SDK ships ESM builds with directory imports that Node's strict
// ESM resolver rejects. Pull types via `import type` and runtime values via
// createRequire (routes through the working CJS build).
const require = createRequire(import.meta.url);
const sdkCore =
  require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core");
const v3Sdk = require("@uniswap/v3-sdk") as typeof import("@uniswap/v3-sdk");

// ─── Demo parameters ───────────────────────────────────────────────────────

export const PENGU_INPUT_HUMAN = process.env.PENGU_INPUT ?? "100";
export const NUM_BUCKETS = 4;
export const SLIPPAGE_TOLERANCE: Percent = new sdkCore.Percent(100, 10_000); // 1% Uniswap leg
export const JUPITER_SLIPPAGE_BPS = 100; // 1% Jupiter leg
export const ROUTE_TTL_SECONDS = 3600n;
export const REWARD_TTL_SECONDS = 7200n;

// ─── Protocol fees (match EVM script & DESIGN §Solver responsibilities) ───
// Applied off-chain per bucket — the on-chain program only hashes the Route
// we hand it. Drift between this and the EVM session's fee math is a
// documented silent-bug class; keep byte-identical.
export const FEE_BPS = 6n; // 0.06% scalar fee
export const FEE_DENOMINATOR = 10_000n;
export const FEE_NUMERATOR = FEE_DENOMINATOR - FEE_BPS;
export const FLAT_FEE_SOURCE = 10_000n; // $0.01 in Solana USDC (6d)

// ─── Solana (source) ──────────────────────────────────────────────────────

export const PENGU_MINT = new PublicKey(
  "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
);
export const USDC_SOLANA = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
export const PENGU_DECIMALS = 6;

// ─── Native SOL input (used by the native-input variant of the demo) ──────
// wSOL mint is the same on every Solana cluster; canonical address.
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
export const SOL_DECIMALS = 9;
// Lamports the user contributes as the swap input. Default 0.01 SOL keeps
// the demo cheap (~$2 at $200/SOL) while still producing a meaningful swap
// output. Override via env for larger or smaller test amounts.
export const SOL_INPUT_LAMPORTS = parseLamports(
  process.env.SOL_INPUT_LAMPORTS ?? "10000000",
);

function parseLamports(raw: string): bigint {
  // BigInt() throws SyntaxError on non-integer input with a stack trace deep
  // inside V8 — wrap it so misconfigured envs surface a clear actionable
  // message before the script even starts.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `SOL_INPUT_LAMPORTS must be a non-negative integer (lamports), got: ${raw}`,
    );
  }
  const value = BigInt(raw);
  if (value === 0n) {
    throw new Error("SOL_INPUT_LAMPORTS must be > 0");
  }
  return value;
}

// ─── Base (destination) ────────────────────────────────────────────────────

export const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TOSHI_BASE: Address = "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4";
export const SWAP_ROUTER_02_BASE: Address =
  "0x2626664c2603336E57B271c5C0b26F421741e481";
export const QUOTER_V2_BASE: Address =
  "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
export const PORTAL_BASE: Address =
  "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
// Memecoin pools settle on the HIGH fee tier on Base. MEDIUM for USDC/TOSHI
// is a dust pool and severely misprices.
export const USDC_TOSHI_FEE: FeeAmount = v3Sdk.FeeAmount.HIGH; // 10000
export const BASE_CHAIN_ID = 8453n;

export const USDC_BASE_TOKEN: Token = new sdkCore.Token(
  8453,
  USDC_BASE,
  6,
  "USDC",
  "USD Coin",
);
export const TOSHI_TOKEN: Token = new sdkCore.Token(
  8453,
  TOSHI_BASE,
  18,
  "TOSHI",
  "Toshi",
);

// ─── Provers (cross-chain message routing) ────────────────────────────────
// Prover identity is committed into the SVM reward (so the SVM Portal's
// `withdraw` validates the proof PDA at `Proof::pda(intent_hash,
// reward.prover)`); `fulfillAndProve` on Base routes the cross-chain message
// through the Base HyperProver.

export const SVM_HYPER_PROVER = new PublicKey(
  "EcooFDTfKVVo5qZcpNoDngMmVXqrG6FQT1D5LDjZEGeR",
);
export const BASE_HYPER_PROVER: Address =
  "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";

// HyperProver uses chain-id-as-domain-id (solver's `hyper.prover.ts:43-45`).
export const SOLANA_HYPERLANE_DOMAIN = CHAIN_ID_SOLANA; // 1399811149n

// ─── Runtime configuration (env-driven) ───────────────────────────────────

export interface Config {
  userKey: Keypair;
  evmKey: Hex;
  rpcUrl: string;
  baseRpc: string;
}

export function loadConfig(): Config {
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
