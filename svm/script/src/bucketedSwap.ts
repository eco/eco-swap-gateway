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
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash, randomFillSync } from "node:crypto";
import bs58 from "bs58";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  http,
  keccak256,
  parseEventLogs,
  zeroAddress,
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

import { EVMRouteAbiItem, portalAbi } from "./abi/portal.js";
import { quoterV2Abi } from "./abi/quoterV2.js";
import { uniswapV3RouterAbi } from "./abi/uniswapV3Router.js";
import {
  Bucket,
  Call,
  CHAIN_ID_SOLANA,
  ECO_SWAP_GATEWAY_PROGRAM_ID,
  FLASH_FULFILLER_PROGRAM_ID,
  LOCAL_PROVER_PROGRAM_ID,
  PORTAL_PROGRAM_ID,
  Reward,
  Route,
  buildAppendFlashFulfillRouteChunkInstruction,
  buildCloseAndSelectInstruction,
  buildFlashFulfillInstruction,
  buildInitFlashFulfillIntentInstruction,
  buildOpenInstruction,
  buildPortalFundInstruction,
  buildPublishInstruction,
  chunkRouteBytes,
  computeBucketsHash,
  computeIntentHash,
  DISCRIMINATOR,
  encodeCalldataWithAccounts,
  encodeReward,
  encodeRoute,
  eventAuthorityPda,
  executorPda,
  flashFulfillIntentPda,
  flashVaultPda,
  fulfillMarkerPda,
  hashReward,
  hashRoute,
  proofCloserPda,
  proofPda,
  snapshotPda,
  vaultAta,
  vaultPda,
  withdrawnMarkerPda,
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

// HyperProver deployments. Prover identity is committed into the SVM reward
// (so the SVM Portal's `withdraw` validates the proof PDA at
// `Proof::pda(intent_hash, reward.prover)`); `fulfillAndProve` on Base routes
// the cross-chain message through the Base HyperProver.
const SVM_HYPER_PROVER = new PublicKey(
  "EcooFDTfKVVo5qZcpNoDngMmVXqrG6FQT1D5LDjZEGeR",
);
const BASE_HYPER_PROVER: Address = "0xC972B26C1E208845Ca8C18c6B83466bFCeED8c2F";

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
  // The reward Base's `fulfill` commits to is the SVM-native Reward hashed
  // via Borsh — same bytes as the SVM Portal commits to under the funded
  // vault. Keeping reward_hash identical across chains is what makes
  // intent_hash identical, which is what the cross-chain prove → withdraw
  // path requires to find the Solana vault.
  svmReward: Reward;
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

    // SVM-native Reward — used as `baseReward` on close_and_select_intent
    // (amount=0 placeholder; program clones and sets the selected bucket's
    // rewardAmount) AND as the reward bytes Base's `fulfill` commits to, so
    // reward_hash is identical across chains.
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

/// Extend a single tx's worth of addresses. The v0 tx packet caps at 1232B;
/// each address is 32B; after ix/account/tx framing ~20 addresses per
/// extend is a safe budget and leaves headroom for the create ix in tx 1.
const ALT_EXTEND_CHUNK = 20;

async function createAndExtendBucketAlt(
  connection: Connection,
  payer: Keypair,
  accounts: PublicKey[],
): Promise<AddressLookupTableAccount> {
  const slot = await connection.getSlot({ commitment: "finalized" });
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });

  const first = accounts.slice(0, ALT_EXTEND_CHUNK);
  const rest: PublicKey[][] = [];
  for (let i = ALT_EXTEND_CHUNK; i < accounts.length; i += ALT_EXTEND_CHUNK) {
    rest.push(accounts.slice(i, i + ALT_EXTEND_CHUNK));
  }

  // Tx 1: create + first extend chunk.
  {
    const ixs: TransactionInstruction[] = [createIx];
    if (first.length > 0) {
      ixs.push(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: altAddress,
          authority: payer.publicKey,
          payer: payer.publicKey,
          addresses: first,
        }),
      );
    }
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    await sendAndConfirmRobust(connection, tx);
  }

  // Subsequent txs: extend per chunk.
  for (const chunk of rest) {
    const ix = AddressLookupTableProgram.extendLookupTable({
      lookupTable: altAddress,
      authority: payer.publicKey,
      payer: payer.publicKey,
      addresses: chunk,
    });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    await sendAndConfirmRobust(connection, tx);
  }

  // ALTs need at least one slot after creation before they can be used in
  // another tx. Wait until `getAddressLookupTable` resolves to a populated
  // account with all expected entries present.
  for (let i = 0; i < 30; i++) {
    const acct = await connection
      .getAddressLookupTable(altAddress)
      .then((r) => r.value);
    if (acct && acct.state.addresses.length >= accounts.length) return acct;
    await sleep(500);
  }
  throw new Error(`ALT ${altAddress.toBase58()} did not activate within 15s`);
}

// ─── Destination fulfill (Base) ────────────────────────────────────────────

// Minimal HyperProver surface — just the fee-quote view used before
// `fulfillAndProve`. Shape matches `MessageBridgeProver.fetchFee(domainID,
// encodedProofs, data)` in the solver's `message-bridge-prover.abi.ts`.
const hyperProverFetchFeeAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "fetchFee",
    inputs: [
      { name: "domainID", type: "uint64" },
      { name: "encodedProofs", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Hyperlane domain ID for the cross-chain message back to Solana. HyperProver
// uses chain-id-as-domain-id (see solver's `hyper.prover.ts:43-45`); Solana
// mainnet chain ID is `CHAIN_ID_SOLANA` from `eco_svm_std` under the
// `mainnet` feature.
const SOLANA_HYPERLANE_DOMAIN = CHAIN_ID_SOLANA; // 1399811149n

async function fulfillAndProveOnBase(
  baseWallet: WalletClient,
  basePublic: PublicClient,
  intentHash: Hex,
  entry: BucketEntry,
  claimant32: Hex, // bytes32 claimant Base stores + Hyperlane relays to Solana
  toshiRecipient: Address, // EVM address that should end up holding TOSHI
): Promise<bigint> {
  // Both chains' intent_hash is keccak256(u64_BE(chain_id) || route_hash ||
  // reward_hash). To keep it identical across SVM ↔ EVM — which the
  // cross-chain prove → withdraw path requires — we commit to the *same*
  // reward_hash on Base that the SVM Portal committed to under the vault.
  // Base's `fulfillAndProve` takes rewardHash as an opaque bytes32, so we
  // just forward the SVM Borsh-based hash here.
  const rewardHash = ("0x" +
    Buffer.from(hashReward(entry.svmReward)).toString("hex")) as Hex;

  // HyperProver proof payload: `abi.encode((bytes32 sourceChainProver,
  // bytes metadata, address hook))`. Only `sourceChainProver` carries
  // meaning in this flow — it tells the destination HyperProver which
  // Solana program to route the cross-chain Hyperlane message to.
  const svmProver32 = ("0x" +
    Buffer.from(SVM_HYPER_PROVER.toBytes()).toString("hex")) as Hex;
  const proofData = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceChainProver", type: "bytes32" },
          { name: "metadata", type: "bytes" },
          { name: "hook", type: "address" },
        ],
      },
    ],
    [{ sourceChainProver: svmProver32, metadata: "0x", hook: zeroAddress }],
  );

  // Quote the Hyperlane mailbox dispatch fee via the Base HyperProver. The
  // `encodedProofs` layout matches solver's `evm.reader.service.ts` —
  // packed(u64 domainID, bytes32 intentHash, bytes32 claimant).
  const encodedProofs = encodePacked(
    ["uint64", "bytes32", "bytes32"],
    [SOLANA_HYPERLANE_DOMAIN, intentHash, claimant32],
  );
  const proverFee = (await basePublic.readContract({
    address: BASE_HYPER_PROVER,
    abi: hyperProverFetchFeeAbi,
    functionName: "fetchFee",
    args: [SOLANA_HYPERLANE_DOMAIN, encodedProofs, proofData],
  })) as bigint;
  console.log(
    `Fulfilling on Base (routeAmount=${entry.routeAmount} USDC 6d; proverFee=${proverFee} wei)…`,
  );

  const approveHash = await baseWallet.writeContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "approve",
    args: [PORTAL_BASE, entry.routeAmount],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
  });
  await basePublic.waitForTransactionReceipt({ hash: approveHash });

  // Some RPCs (Alchemy/QuickNode) keep the approve tx in their internal
  // pending pool for a beat after mining. Without an explicit nonce viem
  // asks for the pending count and can reuse the approve's slot, tripping
  // "replacement transaction underpriced" on the next send. Wait a moment,
  // then lock the nonce to the post-approve `latest`.
  await sleep(2_000);
  const fulfillNonce = await basePublic.getTransactionCount({
    address: baseWallet.account!.address,
    blockTag: "latest",
  });

  // Alchemy's eth_estimateGas chokes on fulfill's nested-bytes[] return with
  // a spurious "-32602 Invalid params" on some providers; pass gas directly
  // to bypass estimation. 800k covers fulfill's ~287k plus the Hyperlane
  // dispatch overhead with headroom.
  const fulfillHash = await baseWallet.writeContract({
    address: PORTAL_BASE,
    abi: portalAbi,
    functionName: "fulfillAndProve",
    args: [
      intentHash,
      entry.routeStruct,
      rewardHash,
      claimant32,
      BASE_HYPER_PROVER,
      SOLANA_HYPERLANE_DOMAIN,
      proofData,
    ],
    account: baseWallet.account!,
    chain: baseWallet.chain!,
    value: proverFee,
    gas: 800_000n,
    nonce: fulfillNonce,
  });
  console.log(`  fulfillAndProve tx: ${fulfillHash}`);

  const receipt = await basePublic.waitForTransactionReceipt({
    hash: fulfillHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`fulfillAndProve reverted (tx ${fulfillHash})`);
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
      log.args.to?.toLowerCase() === toshiRecipient.toLowerCase()
    ) {
      delivered += log.args.value ?? 0n;
    }
  }
  return delivered;
}

// ─── Source-chain withdraw (Solana) ────────────────────────────────────────

// HyperProver `pda_payer_pda` — receives the lamports freed by `close_proof`.
const HYPER_PROVER_PDA_PAYER_SEED = Buffer.from("pda_payer");

function hyperProverPdaPayerPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [HYPER_PROVER_PDA_PAYER_SEED],
    SVM_HYPER_PROVER,
  );
}

/**
 * Proof PDA under an explicit prover program. The helper in `common.ts`
 * hardcodes `LOCAL_PROVER_PROGRAM_ID` (used by the flash-fulfill flow); for
 * the cross-chain reward proof we need it under the HyperProver.
 */
function hyperProverProofPda(intentHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), Buffer.from(intentHash)],
    SVM_HYPER_PROVER,
  );
}

/**
 * Portal's `withdraw` instruction. Accounts mirror `Withdraw` in
 * `eco-routes-svm/programs/portal/src/instructions/withdraw.rs`; remaining
 * accounts are `[from, to, mint]` per reward token (chunk size = 3) followed
 * by prover-specific `close_proof` extras (HyperProver needs `pda_payer`).
 */
function buildWithdrawInstruction(params: {
  payer: PublicKey;
  claimant: PublicKey;
  vaultPda: PublicKey;
  proofPda: PublicKey;
  proofCloserPda: PublicKey;
  proverProgram: PublicKey;
  withdrawnMarkerPda: PublicKey;
  destination: bigint;
  routeHash: Uint8Array;
  reward: Reward;
  transfers: Array<{ from: PublicKey; to: PublicKey; mint: PublicKey }>;
  closeProofExtras: PublicKey[];
}): TransactionInstruction {
  const argsBytes = Buffer.concat([
    ((): Buffer => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(params.destination, 0);
      return b;
    })(),
    Buffer.from(params.routeHash),
    Buffer.from(encodeReward(params.reward)),
  ]);
  const data = Buffer.concat([Buffer.from(DISCRIMINATOR.withdraw), argsBytes]);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: params.claimant, isSigner: false, isWritable: true },
    { pubkey: params.vaultPda, isSigner: false, isWritable: true },
    { pubkey: params.proofPda, isSigner: false, isWritable: true },
    { pubkey: params.proofCloserPda, isSigner: false, isWritable: false },
    { pubkey: params.proverProgram, isSigner: false, isWritable: false },
    { pubkey: params.withdrawnMarkerPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const t of params.transfers) {
    keys.push({ pubkey: t.from, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.to, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.mint, isSigner: false, isWritable: false });
  }
  for (const extra of params.closeProofExtras) {
    keys.push({ pubkey: extra, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId: PORTAL_PROGRAM_ID,
    keys,
    data,
  });
}

async function withdrawOnSolana(params: {
  connection: Connection;
  userKey: Keypair;
  userRewardAta: PublicKey;
  intentHash: Uint8Array;
  routeHash: Uint8Array;
  rewardAmount: bigint;
  winningReward: Reward;
}): Promise<void> {
  const {
    connection,
    userKey,
    userRewardAta,
    intentHash,
    routeHash,
    rewardAmount,
    winningReward,
  } = params;
  const user = userKey.publicKey;

  const [vaultPdaPk] = vaultPda(intentHash);
  const vaultUsdcAta = vaultAta(vaultPdaPk, USDC_SOLANA, TOKEN_PROGRAM_ID);
  const [proofPdaPk] = hyperProverProofPda(intentHash);
  const [proofCloserPk] = proofCloserPda();
  const [withdrawnMarkerPk] = withdrawnMarkerPda(intentHash);
  const [pdaPayerPk] = hyperProverPdaPayerPda();

  // Poll for the Hyperlane relay to land the proof account. ~60s is
  // already baked in upstream; give it up to another ~2min before bailing.
  let proofFound = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const info = await connection.getAccountInfo(proofPdaPk, "confirmed");
    if (info) {
      proofFound = true;
      break;
    }
    if (attempt === 0) {
      console.log(
        `Proof PDA ${proofPdaPk.toBase58()} not yet present; polling every 5s…`,
      );
    }
    await sleep(5_000);
  }
  if (!proofFound) {
    throw new Error(
      `Proof PDA ${proofPdaPk.toBase58()} never landed — Hyperlane relay timed out. ` +
        `The vault is still funded; re-run withdraw once the proof account exists.`,
    );
  }

  const beforeBal = BigInt(
    (await connection.getTokenAccountBalance(userRewardAta, "confirmed")).value
      .amount,
  );

  const withdrawIx = buildWithdrawInstruction({
    payer: user,
    claimant: user,
    vaultPda: vaultPdaPk,
    proofPda: proofPdaPk,
    proofCloserPda: proofCloserPk,
    proverProgram: SVM_HYPER_PROVER,
    withdrawnMarkerPda: withdrawnMarkerPk,
    destination: BASE_CHAIN_ID,
    routeHash,
    reward: winningReward,
    transfers: [{ from: vaultUsdcAta, to: userRewardAta, mint: USDC_SOLANA }],
    closeProofExtras: [pdaPayerPk],
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      withdrawIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([userKey]);
  console.log("Sending withdraw tx on Solana…");
  const sig = await sendAndConfirmRobust(connection, tx);
  console.log(`  withdraw tx: ${sig}`);

  const afterBal = BigInt(
    (await connection.getTokenAccountBalance(userRewardAta, "confirmed")).value
      .amount,
  );
  console.log(
    `  USDC claimed: ${afterBal - beforeBal} (expected ${rewardAmount})`,
  );
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
  const userPenguAta = getAssociatedTokenAddressSync(PENGU_MINT, user);

  // Executor PDA (portal-owned; signs Route calls via invoke_signed). Its
  // USDC ATA is where Jupiter deposits inside the flash_fulfill Route, and
  // its PENGU ATA is where fulfill pre-funds route.tokens.
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
    user, // creator on SVM side
    SVM_HYPER_PROVER, // prover: Solana HyperProver — must match baseRewardForCall below
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

  // 4. Jupiter swap instructions. Authority = executor PDA (portal signs via
  //    invoke_signed during fulfill); destination = executor's USDC ATA so
  //    the Route's open/close_and_select snapshot the same account.
  console.log("Fetching Jupiter swap instructions…");
  const swapIx = await fetchJupiterSwapInstructions(
    quote,
    executorPdaPk,
    executorUsdcAta,
  );
  const jupiterAlts = await resolveJupiterAlts(
    connection,
    swapIx.addressLookupTableAddresses,
  );
  if (swapIx.setupInstructions?.length || swapIx.cleanupInstruction) {
    throw new Error(
      "Jupiter returned setup/cleanup ixs; this flow only supports a single swap ix in the Route",
    );
  }
  const jupiterSwapWeb3 = jupiterIxToWeb3(swapIx.swapInstruction);
  console.log(`  ix accounts: ${jupiterSwapWeb3.keys.length}`);
  console.log(`  ALTs: ${jupiterAlts.length}`);
  console.log();

  // 5. Build the LOCAL intent's Route.
  //
  // The LOCAL intent is same-chain (destination = CHAIN_ID_SOLANA). Its
  // reward is the user's PENGU input, which gets withdrawn to flash_vault
  // and then pre-funded into the executor as route.tokens. The Route's
  // calls run inside portal.fulfill's executor context and replicate the
  // old user sandwich: open snapshots executor's USDC ATA at 0, Jupiter
  // swaps PENGU → USDC into that same ATA, close_and_select_intent measures
  // the delta and funds the downstream (Base) intent vault.
  // Must mirror the per-bucket `svmReward` built in `buildBucketEntries` —
  // the Solana Portal's `withdraw` recomputes `types::intent_hash(dst,
  // route_hash, reward.hash())` and derives the proof PDA at
  // `Proof::pda(intent_hash, reward.prover)`, so the prover here has to be
  // the same HyperProver program the Base side routes its proof through.
  const baseRewardForCall: Reward = {
    deadline: rewardDeadline,
    creator: user,
    prover: SVM_HYPER_PROVER,
    nativeAmount: 0n,
    tokens: [{ token: USDC_SOLANA, amount: 0n }],
  };

  const openCallIx = buildOpenInstruction(executorPdaPk, executorUsdcAta);
  const closeCallIx = buildCloseAndSelectInstruction(
    {
      user: executorPdaPk,
      userRewardAta: executorUsdcAta,
      sweepRecipientAta,
      mint: USDC_SOLANA,
    },
    {
      destination: BASE_CHAIN_ID,
      baseReward: baseRewardForCall,
      buckets: entries.map((e) => e.bucket),
    },
    vaultPairs,
  );

  const salt = Uint8Array.from(randomFillSync(Buffer.alloc(32)));
  const localPenguReward: Reward = {
    deadline: rewardDeadline,
    creator: user,
    // portal.withdraw validates `reward.prover == prover_account.key()`,
    // and flash_fulfill CPIs into the local-prover program — so the reward
    // must commit to the local-prover's program ID, not the user.
    prover: LOCAL_PROVER_PROGRAM_ID,
    nativeAmount: 0n,
    tokens: [{ token: PENGU_MINT, amount: inputAmount }],
  };
  // Precompute MAX `isWritable` for every pubkey that appears in ANY of the
  // three Route-call ixs. Solana's tx compiler dedups each pubkey with the
  // most-permissive flags, and portal reconstructs CalldataWithAccounts from
  // the resulting AccountInfo at CPI time — so committed CalldataWithAccounts
  // must match the post-dedup view or the route hash diverges from portal's
  // reconstruction and fulfill reverts with InvalidIntentHash.
  //
  // We only dedup across call-ix keys. Writability conflicts driven by the
  // flash_fulfill fixed accounts (executor, etc.) resolve the same way since
  // those accounts are already writable there, so their call-ix appearance
  // gets its flag bumped the same. The only pubkeys whose writability
  // actually flips across call ixs are executor PDA and executor USDC ATA
  // (open marks them w=false, jupiter/close mark them w=true).
  const writableSet: Set<string> = new Set();
  for (const ix of [openCallIx, jupiterSwapWeb3, closeCallIx]) {
    for (const k of ix.keys) {
      if (k.isWritable) writableSet.add(k.pubkey.toBase58());
    }
  }
  // executor PDA is writable at the outer flash_fulfill fixed-accounts slot;
  // that dedups with jupiter's readonly appearance and flips it writable.
  writableSet.add(executorPdaPk.toBase58());

  const localRoute: Route = {
    salt,
    deadline: routeDeadline,
    portal: PORTAL_PROGRAM_ID.toBytes(),
    nativeAmount: 0n,
    tokens: [{ token: PENGU_MINT, amount: inputAmount }],
    calls: [
      {
        target: ECO_SWAP_GATEWAY_PROGRAM_ID.toBytes(),
        data: encodeCalldataWithAccounts(openCallIx, writableSet),
      },
      {
        target: jupiterSwapWeb3.programId.toBytes(),
        data: encodeCalldataWithAccounts(jupiterSwapWeb3, writableSet),
      },
      {
        target: ECO_SWAP_GATEWAY_PROGRAM_ID.toBytes(),
        data: encodeCalldataWithAccounts(closeCallIx, writableSet),
      },
    ],
  };
  const localRouteBytes = encodeRoute(localRoute);
  const localRouteHash = hashRoute(localRoute);
  const localRewardHash = hashReward(localPenguReward);
  const localIntentHash = computeIntentHash(
    CHAIN_ID_SOLANA,
    localRouteHash,
    localRewardHash,
  );
  const [localVaultPdaPk] = vaultPda(localIntentHash);
  const localVaultPenguAta = vaultAta(
    localVaultPdaPk,
    PENGU_MINT,
    TOKEN_PROGRAM_ID,
  );
  console.log(`LOCAL intent_hash: 0x${hexOf(localIntentHash)}`);
  console.log(
    `  Route bytes: ${localRouteBytes.length}B (> 1232 → chunked upload)`,
  );
  console.log();

  // 6. Setup tx: fund the LOCAL intent with PENGU via portal.fund, pre-create
  //    the executor's USDC ATA (so open can snapshot pre_balance=0), and
  //    top up the executor PDA with lamports for the snapshot PDA's rent
  //    (close_and_select closes the snapshot back to the executor, so
  //    lamports get refunded on the round trip).
  console.log("Sending setup tx (fund LOCAL intent + prep executor)…");
  const setupIxs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    buildPortalFundInstruction({
      payer: user,
      funder: user,
      vaultPda: localVaultPdaPk,
      destination: CHAIN_ID_SOLANA,
      routeHash: localRouteHash,
      reward: localPenguReward,
      allowPartial: false,
      transfers: [
        { from: userPenguAta, to: localVaultPenguAta, mint: PENGU_MINT },
      ],
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      executorUsdcAta,
      executorPdaPk,
      USDC_SOLANA,
    ),
    // 2M lamports ≈ 0.002 SOL covers the snapshot PDA's rent-exempt
    // reserve. close_and_select refunds it to `user` (= executor) inside
    // the Route, so repeated runs don't drift the executor's balance up.
    SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: executorPdaPk,
      lamports: 2_000_000,
    }),
  ];
  {
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: setupIxs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([config.userKey]);
    const sig = await sendAndConfirmRobust(connection, tx);
    console.log(`  tx: ${sig}`);
  }
  console.log();

  // 7. init_flash_fulfill_intent — commit the preimage, allocate buffer PDA.
  console.log("Sending init_flash_fulfill_intent…");
  {
    const initIx = buildInitFlashFulfillIntentInstruction({
      writer: user,
      intentHash: localIntentHash,
      routeHash: localRouteHash,
      reward: localPenguReward,
      routeTotalSize: localRouteBytes.length,
    });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      // flash_fulfiller runs a 256 KB custom allocator (see eco-routes-svm
      // flash-fulfiller/src/lib.rs). Any tx invoking this program MUST
      // request the matching heap frame — otherwise the allocator hands out
      // pointers past the VM's default 32 KB heap region and writes
      // access-violate.
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        initIx,
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([config.userKey]);
    const sig = await sendAndConfirmRobust(connection, tx);
    console.log(`  tx: ${sig}`);
  }

  // 8. append_flash_fulfill_route_chunk — stream bytes into the buffer.
  //    Final chunk auto-finalizes (keccak + Borsh-decode validation).
  const chunks = chunkRouteBytes(localRouteBytes);
  console.log(`Uploading Route in ${chunks.length} chunk(s)…`);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const appendIx = buildAppendFlashFulfillRouteChunkInstruction({
      writer: user,
      intentHash: localIntentHash,
      offset,
      chunk,
    });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      // flash_fulfiller's 256 KB allocator requires the matching heap frame
      // on every invoking tx; see init_flash_fulfill_intent above for detail.
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        appendIx,
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([config.userKey]);
    const sig = await sendAndConfirmRobust(connection, tx);
    console.log(
      `  chunk ${i + 1}/${chunks.length} (${chunk.length}B @ offset ${offset}): ${sig}`,
    );
    offset += chunk.length;
  }
  console.log();

  // 9. flash_fulfill — prove → withdraw → fulfill → sweep, all atomic.
  //    Has ~60+ accounts after adding Route-call accounts, so we build a
  //    per-session ALT for the flash-fulfill fixed/derived accounts and
  //    compose it with the existing bucketAlt + jupiterAlts.
  const [flashVaultPk] = flashVaultPda();
  const [flashFulfillIntentPk] = flashFulfillIntentPda(localIntentHash, user);
  const [proofPk] = proofPda(localIntentHash);
  const [proofCloserPk] = proofCloserPda();
  const [fulfillMarkerPk] = fulfillMarkerPda(localIntentHash);
  const [withdrawnMarkerPk] = withdrawnMarkerPda(localIntentHash);
  const [localProverEventAuthorityPk] = eventAuthorityPda(
    LOCAL_PROVER_PROGRAM_ID,
  );
  const [flashFulfillerEventAuthorityPk] = eventAuthorityPda(
    FLASH_FULFILLER_PROGRAM_ID,
  );
  const flashVaultPenguAta = vaultAta(
    flashVaultPk,
    PENGU_MINT,
    TOKEN_PROGRAM_ID,
  );

  const flashFulfillIx = buildFlashFulfillInstruction({
    payer: user,
    flashVault: flashVaultPk,
    flashFulfillIntent: flashFulfillIntentPk,
    claimant: user,
    proof: proofPk,
    intentVault: localVaultPdaPk,
    withdrawnMarker: withdrawnMarkerPk,
    proofCloser: proofCloserPk,
    executor: executorPdaPk,
    fulfillMarker: fulfillMarkerPk,
    portalProgram: PORTAL_PROGRAM_ID,
    localProverProgram: LOCAL_PROVER_PROGRAM_ID,
    localProverEventAuthority: localProverEventAuthorityPk,
    flashFulfillerEventAuthority: flashFulfillerEventAuthorityPk,
    intentHash: localIntentHash,
    rewardTransfers: [
      { from: localVaultPenguAta, to: flashVaultPenguAta, mint: PENGU_MINT },
    ],
    routeTransfers: [
      { from: flashVaultPenguAta, to: executorPenguAta, mint: PENGU_MINT },
    ],
    claimantAtas: [userPenguAta],
    // Ordering is LOAD-BEARING: portal.fulfill's execute_route_calls consumes
    // remaining_accounts in strict order, `calldata.account_count` entries per
    // Call. Target program AccountInfos (eco_swap_gateway, Jupiter) must NOT
    // fall inside any call's consumed range or Anchor will read them at the
    // wrong field positions. We append them AFTER all consumed slots — they're
    // still in the tx's loaded-accounts set (which is what Solana uses to
    // resolve `invoke_signed` target program IDs), just not consumed by
    // portal's per-call iterator.
    callAccounts: [
      ...openCallIx.keys,
      ...jupiterSwapWeb3.keys,
      ...closeCallIx.keys,
      {
        pubkey: ECO_SWAP_GATEWAY_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: jupiterSwapWeb3.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
  });

  // Fresh ALT holding all flash_fulfill-specific pubkeys we can lift out.
  // User keys (payer / claimant) stay in the tx header; everything else
  // goes in the ALT to stay under 1232B with this account count.
  const flashFulfillAltKeys = Array.from(
    new Set(
      [
        flashVaultPk,
        flashFulfillIntentPk,
        proofPk,
        localVaultPdaPk,
        withdrawnMarkerPk,
        proofCloserPk,
        executorPdaPk,
        fulfillMarkerPk,
        PORTAL_PROGRAM_ID,
        LOCAL_PROVER_PROGRAM_ID,
        localProverEventAuthorityPk,
        flashFulfillerEventAuthorityPk,
        FLASH_FULFILLER_PROGRAM_ID,
        ECO_SWAP_GATEWAY_PROGRAM_ID,
        jupiterSwapWeb3.programId,
        PENGU_MINT,
        USDC_SOLANA,
        localVaultPenguAta,
        flashVaultPenguAta,
        executorPenguAta,
        executorUsdcAta,
        userPenguAta,
        ...openCallIx.keys.map((k) => k.pubkey),
        ...closeCallIx.keys.map((k) => k.pubkey),
      ].map((k) => k.toBase58()),
    ),
  ).map((s) => new PublicKey(s));

  console.log(
    `Creating per-quote flash-fulfill ALT (${flashFulfillAltKeys.length} entries)…`,
  );
  const flashFulfillAlt = await createAndExtendBucketAlt(
    connection,
    config.userKey,
    flashFulfillAltKeys,
  );
  console.log(`  ALT: ${flashFulfillAlt.key.toBase58()}`);
  console.log();

  console.log("Sending flash_fulfill tx…");
  let flashFulfillSig: string;
  {
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      // CU limit at the max (1.4M): flash_fulfill does prove + withdraw +
      // fulfill + route-calls (incl. a full Jupiter swap) + sweeps in one
      // invocation.
      //
      // RequestHeapFrame at the 256 KB cap: flash_fulfiller's PR #48 fix
      // (zero-copy strip_call_accounts + Vec::with_capacity in cpi::fulfill)
      // reduces heap pressure enough to pass a litesvm repro with the 32 KB
      // default, but on mainnet the real CPI overhead (live account data
      // marshalling, Jupiter's ~27 accounts, real Borsh round-trips) still
      // exceeds 32 KB. Both pieces are load-bearing here — the program fix
      // alone OOMs, and the heap bump alone OOMed pre-fix.
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        // Without a priority fee the ~574B flash_fulfill tx gets dropped on
        // busy slots — the validator prioritizes tip-paying txs. 200k
        // microlamports/CU × 1.4M CU ≈ 0.00028 SOL ceiling, cheap insurance
        // against mainnet congestion.
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        flashFulfillIx,
      ],
    }).compileToV0Message([flashFulfillAlt, bucketAlt, ...jupiterAlts]);
    const tx = new VersionedTransaction(msg);
    tx.sign([config.userKey]);
    console.log(`  serialized: ${tx.serialize().length}B`);
    flashFulfillSig = await sendAndConfirmRobust(connection, tx);
    console.log(`  tx: ${flashFulfillSig}`);
  }

  // 10. Parse IntentSelected from the flash_fulfill tx — this comes from
  //     close_and_select_intent running as a Route call, and tells us which
  //     bucket won (which downstream Base intent got funded).
  const selection = await parseIntentSelected(
    connection,
    flashFulfillSig,
    entries,
  );
  console.log();
  console.log("Downstream intent selected!");
  console.log(`  intentHash:    0x${hexOf(selection.intentHash)}`);
  console.log(`  bucketIndex:   ${selection.bucketIndex}`);
  console.log(`  rewardAmount:  ${selection.rewardAmount}`);
  console.log(`  swapDelta:     ${selection.delta} (USDC 6d)`);
  console.log();

  logSwapSlippage("Source swap (PENGU → USDC inside flash_fulfill)", {
    expectedOut: jupiterOutAmount,
    minOut: jupiterMinOut,
    actualOut: selection.delta,
    decimals: 6,
    symbol: "USDC",
  });

  // 11. Re-emit portal::IntentFunded for the downstream (Base) intent.
  //     close_and_select_intent funded the vault directly (no portal CPI),
  //     so portal's canonical event didn't fire. A no-op portal.fund tx
  //     (allow_partial=true, vault already fully funded → 0 transferred)
  //     re-emits the canonical event for indexers keyed on it.
  const selectedEntry = entries[selection.bucketIndex];
  const winningReward: Reward = {
    ...selectedEntry.svmReward,
    tokens: [
      {
        ...selectedEntry.svmReward.tokens[0],
        amount: selection.rewardAmount,
      },
    ],
  };
  const winningVault = vaultPairs[selection.bucketIndex];
  console.log("Re-emitting portal::IntentFunded (no-op portal.fund)…");
  {
    const reEmitIx = buildPortalFundInstruction({
      payer: user,
      funder: user,
      vaultPda: winningVault.vaultPda,
      destination: BASE_CHAIN_ID,
      routeHash: selectedEntry.bucket.routeHash,
      reward: winningReward,
      allowPartial: true,
      transfers: [
        { from: userRewardAta, to: winningVault.vaultAta, mint: USDC_SOLANA },
      ],
    });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [reEmitIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([config.userKey]);
    const sig = await sendAndConfirmRobust(connection, tx);
    console.log(`  tx: ${sig}`);
  }

  // 12. Post-publish the winning route. Best-effort: publish is for
  //     indexers, not required for fulfill. Can overflow 1232B for
  //     multi-call EVM calldata — we log and move on if it does.
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
    const publishSig = await sendAndConfirmRobust(connection, publishTx);
    console.log(`  publish tx: ${publishSig}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  publish skipped: ${msg}`);
    console.log(
      `  (intent is funded on-chain; solver can still fulfill using the in-memory Route bytes)`,
    );
  }
  console.log();

  // 8. Act as solver on Base: `fulfillAndProve` the funded intent. The
  //    intent_hash Base commits to is the one already emitted in
  //    `IntentSelected` on Solana — identical formula, shared route_hash,
  //    and (via `fulfillAndProveOnBase`) shared Borsh-based reward_hash.
  //    Base's Inbox recomputes keccak(u64(CHAIN_ID) || routeHash ||
  //    rewardHash) and reverts if it doesn't match. The appended `prove`
  //    step dispatches a Hyperlane message to the Solana HyperProver so
  //    the solver can later `withdraw` the reward from the SVM vault.
  const intentHash = ("0x" + hexOf(selection.intentHash)) as Hex;
  // Claim on the source chain: use the SVM user's pubkey as the 32-byte
  // claimant so the Hyperlane-delivered `proof.claimant` resolves to an
  // on-curve Solana pubkey with an existing USDC ATA.
  const claimant32 = ("0x" +
    Buffer.from(user.toBytes()).toString("hex")) as Hex;
  console.log(`intent_hash: ${intentHash}`);
  console.log(`claimant:    ${user.toBase58()} (as bytes32 on Base)`);
  console.log();
  const toshiDelivered = await fulfillAndProveOnBase(
    baseWallet,
    basePublic,
    intentHash,
    selectedEntry,
    claimant32,
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

  // 9. Wait a minute for Hyperlane to relay the cross-chain proof from Base
  //    back to the Solana HyperProver, then withdraw the USDC reward from
  //    the SVM vault into the user's USDC ATA. `withdraw` validates the
  //    proof PDA (written by the HyperProver's `handle` on message receipt)
  //    against `(intent_hash, reward.prover)`, so if the relay hasn't
  //    landed yet we poll briefly before giving up.
  console.log("Waiting 60s for Hyperlane relay (Base → Solana)…");
  await sleep(60_000);
  await withdrawOnSolana({
    connection,
    userKey: config.userKey,
    userRewardAta,
    intentHash: selection.intentHash,
    routeHash: selectedEntry.bucket.routeHash,
    rewardAmount: selection.rewardAmount,
    winningReward,
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

/**
 * Send a v0 tx and poll signature status until it confirms. Avoids the
 * `connection.confirmTransaction({blockhash, lastValidBlockHeight})` path,
 * which throws `TransactionExpiredBlockheightExceededError` the moment the
 * blockhash ages out — even if the tx lands a moment later. This poller
 * cares about the tx's *actual* status, not about the blockhash window.
 */
async function sendAndConfirmRobust(
  connection: Connection,
  tx: VersionedTransaction,
  timeoutMs = 120_000,
): Promise<string> {
  // sendTransaction can transiently fail with "Blockhash not found" while
  // the freshly-fetched blockhash propagates across the RPC's forwarder
  // set. Retry a few times with backoff before giving up.
  let sig: string | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      sig = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 5,
      });
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Blockhash not found|Node is behind/.test(msg)) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  if (!sig) throw lastErr;
  // RPC forwarders sometimes drop a tx after the initial submit without
  // surfacing it to leaders. Re-submit the raw bytes every `RESEND_MS`
  // until the cluster confirms it or the blockhash ages out. The same
  // signature is deterministic from the raw bytes, so duplicates are
  // silently deduplicated cluster-side.
  const rawTx = tx.serialize();
  const RESEND_MS = 5_000;
  const start = Date.now();
  let lastResend = start;
  while (Date.now() - start < timeoutMs) {
    const s = await connection.getSignatureStatus(sig, {
      searchTransactionHistory: true,
    });
    if (s.value?.err) {
      throw new Error(`tx ${sig} failed: ${JSON.stringify(s.value.err)}`);
    }
    const c = s.value?.confirmationStatus;
    if (c === "confirmed" || c === "finalized") return sig;
    if (Date.now() - lastResend >= RESEND_MS) {
      try {
        await connection.sendRawTransaction(rawTx, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch {
        // Re-submit errors are expected (AlreadyProcessed after confirm,
        // forwarder rate limits) — keep polling.
      }
      lastResend = Date.now();
    }
    await sleep(1500);
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs / 1000}s`);
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
