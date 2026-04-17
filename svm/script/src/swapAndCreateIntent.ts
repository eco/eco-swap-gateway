/**
 * SwapIntent Example: Fartcoin → USDC on Solana, then USDC on Base
 *
 * This script demonstrates the full sandwich pattern:
 *   1. SwapIntent::open  (snapshot USDC balance)
 *   2. Jupiter swap      (Fartcoin → USDC)
 *   3. SwapIntent::close_and_create_intent (compute fees, patch route, CPI Portal)
 *
 * All three go in a single atomic versioned transaction.
 *
 * Usage:
 *   PRIVATE_KEY=<base58> npx tsx src/swapAndCreateIntent.ts
 */

import "dotenv/config";
import crypto from "crypto";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  padHex,
  type Hex,
  type Address,
} from "viem";
import { keccak256 as viemKeccak256 } from "viem";
import bs58 from "bs58";

// ─── Configuration ─────────────────────────────────────────────────────────

const FARTCOIN_AMOUNT = 0n; // Use raw amount below instead
const FARTCOIN_RAW_AMOUNT = 300_000n; // 0.3 Fartcoin (raw, 6 decimals)
const FARTCOIN_DECIMALS = 6;

// ─── Constants ─────────────────────────────────────────────────────────────

// Solana addresses
const FARTCOIN_MINT = new PublicKey(
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
);
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SWAP_INTENT_PROGRAM = new PublicKey(
  "SwapXCqJ3cwYZVUinbG6zxJYLgX4joT9KqvGqetnj5d",
);
const PORTAL_PROGRAM = new PublicKey(
  "Ecoo5HDM2XCBy7QzkhDGrAmnRcWw7emU6xGr7CcCmooo",
);
const HYPER_PROVER = new PublicKey(
  "EcooFDTfKVVo5qZcpNoDngMmVXqrG6FQT1D5LDjZEGeR",
);

// Base addresses (destination chain)
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PORTAL_BASE: Address = "0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97";
const BASE_CHAIN_ID = 8453n;

// Fee parameters (matching EVM script: 6 bps scalar, $0.01 flat)
const SCALAR_FEE_BPS = 6n;
const SCALAR_DENOM = 10000n;
const SCALAR_NUM = SCALAR_DENOM - SCALAR_FEE_BPS; // 9994
const FLAT_FEE = 10_000n; // $0.01 in 6-decimal USDC

// Decimal config
const SOURCE_DECIMALS = 6; // USDC on Solana
const DESTINATION_DECIMALS = 6; // USDC on Base

// Instruction discriminators (from Anchor IDL)
const WRITE_ROUTE_BUFFER_DISCRIMINATOR = Buffer.from([
  75, 235, 140, 42, 51, 248, 84, 98,
]);
const OPEN_DISCRIMINATOR = Buffer.from([228, 220, 155, 71, 199, 189, 60, 45]);
const CLOSE_DISCRIMINATOR = Buffer.from([122, 166, 202, 12, 24, 110, 189, 7]);
const CANCEL_DISCRIMINATOR = Buffer.from([
  232, 219, 223, 41, 219, 236, 220, 190,
]);

// PDA seeds
const SWAP_STATE_SEED = Buffer.from("swap_state");
const ROUTE_BUFFER_SEED = Buffer.from("route_buffer");
const VAULT_SEED = Buffer.from("vault");

// Skip calldata patch sentinel
const SKIP_CALLDATA_PATCH = 0xffffffff;

// ─── ABI Type for EVM Route ────────────────────────────────────────────────

const EVMRouteAbiType = {
  type: "tuple" as const,
  components: [
    { name: "salt", type: "bytes32" as const },
    { name: "deadline", type: "uint64" as const },
    { name: "portal", type: "address" as const },
    { name: "nativeAmount", type: "uint256" as const },
    {
      name: "tokens",
      type: "tuple[]" as const,
      components: [
        { name: "token", type: "address" as const },
        { name: "amount", type: "uint256" as const },
      ],
    },
    {
      name: "calls",
      type: "tuple[]" as const,
      components: [
        { name: "target", type: "address" as const },
        { name: "data", type: "bytes" as const },
        { name: "value", type: "uint256" as const },
      ],
    },
  ],
};

// ─── Route Template Builder ────────────────────────────────────────────────

/**
 * Build an ABI-encoded route template and compute the byte offsets where
 * the on-chain program must patch the actual `routeAmount`.
 *
 * Uses a unique MARKER value to locate the amount positions, then replaces
 * them with zero. Follows the same pattern as the EVM script.
 */
function buildRouteTemplate(recipient: Address): {
  routeTemplate: Buffer;
  tokensAmountOffset: number;
  calldataAmountOffset: number;
} {
  const MARKER = BigInt(
    "0xDEAD00000000000000000000000000000000000000000000000000000000BEEF",
  );
  const markerHex = padHex(`0x${MARKER.toString(16)}`, { size: 32 })
    .toLowerCase()
    .slice(2);

  const routeDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const salt = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;

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

  const encoded = encodeAbiParameters([EVMRouteAbiType], [route]);
  const hex = encoded.slice(2).toLowerCase();

  const firstPos = hex.indexOf(markerHex);
  if (firstPos === -1) throw new Error("MARKER not found (tokens.amount)");
  const tokensAmountOffset = firstPos / 2;

  const secondPos = hex.indexOf(markerHex, firstPos + 1);
  if (secondPos === -1) throw new Error("MARKER not found (calldata.amount)");
  const calldataAmountOffset = secondPos / 2;

  // Replace markers with zero — the program patches them on-chain
  const zeroWord = "0".repeat(64);
  const cleanHex = hex.replaceAll(markerHex, zeroWord);
  const routeTemplate = Buffer.from(cleanHex, "hex");

  return { routeTemplate, tokensAmountOffset, calldataAmountOffset };
}

// ─── Hash Helpers ──────────────────────────────────────────────────────────

/** keccak256 using viem */
function keccak256(data: Buffer): Buffer {
  const hash = viemKeccak256(`0x${data.toString("hex")}` as Hex);
  return Buffer.from(hash.slice(2), "hex");
}

/** Write a u64 as little-endian 8 bytes (Borsh encoding) */
function writeU64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/** Write a u32 as little-endian 4 bytes (Borsh Vec length prefix) */
function writeU32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/**
 * Borsh-serialize a Reward struct and keccak256 it.
 * Must exactly match Portal's Reward::hash() on-chain.
 *
 * Layout: deadline(u64 LE) + creator(32) + prover(32) + native_amount(u64 LE)
 *         + tokens_len(u32 LE) + [token(32) + amount(u64 LE)]*
 */
function hashReward(reward: {
  deadline: bigint;
  creator: PublicKey;
  prover: PublicKey;
  nativeAmount: bigint;
  tokens: Array<{ token: PublicKey; amount: bigint }>;
}): Buffer {
  const parts: Buffer[] = [
    writeU64LE(reward.deadline),
    reward.creator.toBuffer(),
    reward.prover.toBuffer(),
    writeU64LE(reward.nativeAmount),
    writeU32LE(reward.tokens.length),
  ];
  for (const t of reward.tokens) {
    parts.push(t.token.toBuffer());
    parts.push(writeU64LE(t.amount));
  }
  return keccak256(Buffer.concat(parts));
}

/**
 * Compute route_hash = keccak256(patchedRouteTemplate).
 * The template has the route_amount written at both offsets as BE uint256.
 */
function computeRouteHash(
  routeTemplate: Buffer,
  routeAmount: bigint,
  tokensAmountOffset: number,
  calldataAmountOffset: number,
): Buffer {
  const patched = Buffer.from(routeTemplate);
  const amountBE = toBEUint256(routeAmount);
  amountBE.copy(patched, tokensAmountOffset);
  amountBE.copy(patched, calldataAmountOffset);
  return keccak256(patched);
}

/** Convert a bigint to a 32-byte big-endian uint256 */
function toBEUint256(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

/**
 * intent_hash = keccak256(destination_be8 || route_hash || reward_hash)
 */
function computeIntentHash(
  destination: bigint,
  routeHash: Buffer,
  rewardHash: Buffer,
): Buffer {
  const destBuf = Buffer.alloc(8);
  destBuf.writeBigUInt64BE(destination);
  return keccak256(Buffer.concat([destBuf, routeHash, rewardHash]));
}

// ─── Borsh Encoding ────────────────────────────────────────────────────────

/** Encode WriteRouteBufferArgs: route_template (Vec<u8>) + two u32 offsets */
function encodeWriteRouteBufferArgs(
  routeTemplate: Buffer,
  tokensAmountOffset: number,
  calldataAmountOffset: number,
): Buffer {
  const offsetBuf1 = Buffer.alloc(4);
  offsetBuf1.writeUInt32LE(tokensAmountOffset);
  const offsetBuf2 = Buffer.alloc(4);
  offsetBuf2.writeUInt32LE(calldataAmountOffset);
  return Buffer.concat([
    writeU32LE(routeTemplate.length),
    routeTemplate,
    offsetBuf1,
    offsetBuf2,
  ]);
}

/** Encode CreateIntentArgs (no route — read from buffer PDA) */
function encodeCreateIntentArgs(args: {
  destination: bigint;
  rewardDeadline: bigint;
  rewardCreator: PublicKey;
  rewardProver: PublicKey;
  rewardToken: PublicKey;
  rewardAmount: bigint;
  flatFee: bigint;
  scalarNum: bigint;
  scalarDenom: bigint;
  sourceDecimals: number;
  destinationDecimals: number;
  allowPartial: boolean;
}): Buffer {
  return Buffer.concat([
    writeU64LE(args.destination),
    writeU64LE(args.rewardDeadline),
    args.rewardCreator.toBuffer(),
    args.rewardProver.toBuffer(),
    args.rewardToken.toBuffer(),
    writeU64LE(args.rewardAmount),
    writeU64LE(args.flatFee),
    writeU64LE(args.scalarNum),
    writeU64LE(args.scalarDenom),
    Buffer.from([args.sourceDecimals]),
    Buffer.from([args.destinationDecimals]),
    Buffer.from([args.allowPartial ? 1 : 0]),
  ]);
}

// ─── Jupiter API ───────────────────────────────────────────────────────────

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  routePlan: unknown[];
}

interface JupiterSwapInstructions {
  setupInstructions: JupiterIx[];
  swapInstruction: JupiterIx;
  cleanupInstruction: JupiterIx | null;
  addressLookupTableAddresses: string[];
}

interface JupiterIx {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
): Promise<JupiterQuote> {
  // 300 bps (3%) slippage for volatile tokens. The actual swap output is read
  // after confirmation to compute the exact vault PDA for close_and_create.
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.statusText}`);
  return res.json();
}

async function getJupiterSwapInstructions(
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<JupiterSwapInstructions> {
  const res = await fetch("https://api.jup.ag/swap/v1/swap-instructions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Jupiter swap-instructions failed: ${res.statusText} — ${body}`,
    );
  }
  return res.json();
}

function jupiterIxToInstruction(ix: JupiterIx): TransactionInstruction {
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

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var is required");

  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

  const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  const connection = new Connection(rpcUrl, "confirmed");
  const user = keypair.publicKey;

  const inputAmount = FARTCOIN_RAW_AMOUNT;
  const rewardDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);

  console.log(`User:           ${user.toBase58()}`);
  console.log(
    `Input:          ${Number(inputAmount) / 10 ** FARTCOIN_DECIMALS} Fartcoin (${inputAmount} raw)`,
  );
  console.log(`Swap:           Fartcoin → USDC on Solana (Jupiter)`);
  console.log(`Intent:         USDC on Solana → USDC on Base`);
  console.log();

  // 1. Get Jupiter quote
  console.log("Fetching Jupiter quote...");
  const quote = await getJupiterQuote(
    FARTCOIN_MINT.toBase58(),
    USDC_MINT.toBase58(),
    inputAmount,
  );
  const swapOutput = BigInt(quote.outAmount);
  console.log(`  Expected output: ${swapOutput} USDC (raw, 6 decimals)`);
  console.log();

  // 2. Get Jupiter swap instructions
  console.log("Fetching Jupiter swap instructions...");
  const jupiterIxs = await getJupiterSwapInstructions(quote, user.toBase58());

  // 3. Build route template (destination chain: Base)
  const recipient =
    `0x${Buffer.from(user.toBytes()).toString("hex").slice(0, 40)}` as Address;
  const { routeTemplate, tokensAmountOffset, calldataAmountOffset } =
    buildRouteTemplate(recipient);

  console.log(`Route template:          ${routeTemplate.length} bytes`);
  console.log(`tokensAmountOffset:      ${tokensAmountOffset}`);
  console.log(`calldataAmountOffset:    ${calldataAmountOffset}`);
  console.log();

  // 4. Derive PDAs
  const rewardAmount = 0n; // 0 = use full swap_output on-chain
  const [swapStatePda] = PublicKey.findProgramAddressSync(
    [SWAP_STATE_SEED, user.toBuffer()],
    SWAP_INTENT_PROGRAM,
  );
  const [routeBufferPda] = PublicKey.findProgramAddressSync(
    [ROUTE_BUFFER_SEED, user.toBuffer()],
    SWAP_INTENT_PROGRAM,
  );
  const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, user);

  // Cancel stale swap state if exists (from a previous failed run)
  const existingState = await connection.getAccountInfo(swapStatePda);
  if (existingState && existingState.lamports > 0) {
    console.log("Found stale swap state PDA — cancelling...");
    const cancelIx = new TransactionInstruction({
      programId: SWAP_INTENT_PROGRAM,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: swapStatePda, isSigner: false, isWritable: true },
      ],
      data: CANCEL_DISCRIMINATOR,
    });
    const { blockhash: cbh, lastValidBlockHeight: clvbh } =
      await connection.getLatestBlockhash("confirmed");
    const cancelMsg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: cbh,
      instructions: [cancelIx],
    }).compileToV0Message([]);
    const cancelTx = new VersionedTransaction(cancelMsg);
    cancelTx.sign([keypair]);
    const cancelSig = await connection.sendTransaction(cancelTx);
    await connection.confirmTransaction(
      { signature: cancelSig, blockhash: cbh, lastValidBlockHeight: clvbh },
      "confirmed",
    );
    console.log(`  Cancelled: ${cancelSig}`);
    console.log();
  }

  const preSwapInfo = await connection.getTokenAccountBalance(userUsdcAta);
  const preSwapBalance = BigInt(preSwapInfo.value.amount);
  console.log(`Pre-swap USDC:    ${preSwapBalance}`);
  console.log(`Swap state PDA:   ${swapStatePda.toBase58()}`);
  console.log(`Route buffer PDA: ${routeBufferPda.toBase58()}`);
  console.log();

  // 5. Resolve Jupiter Address Lookup Tables
  const lookupTableAddresses = jupiterIxs.addressLookupTableAddresses.map(
    (addr) => new PublicKey(addr),
  );
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const addr of lookupTableAddresses) {
    const result = await connection.getAddressLookupTable(addr);
    if (result.value) lookupTables.push(result.value);
  }

  // ─── Setup Tx: write_route_buffer ────────────────────────────────────────
  // Always write a fresh buffer. If a stale one exists (from a failed run),
  // close it first via close_route_buffer.

  const CLOSE_ROUTE_BUFFER_DISCRIMINATOR = Buffer.from([
    66, 5, 208, 96, 30, 99, 2, 238,
  ]);

  const existingBuffer = await connection.getAccountInfo(routeBufferPda);
  if (existingBuffer && existingBuffer.lamports > 0) {
    console.log("Closing stale route buffer...");
    const closeBufferIx = new TransactionInstruction({
      programId: SWAP_INTENT_PROGRAM,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: routeBufferPda, isSigner: false, isWritable: true },
      ],
      data: CLOSE_ROUTE_BUFFER_DISCRIMINATOR,
    });
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [closeBufferIx],
    }).compileToV0Message([]);
    const tx = new VersionedTransaction(msg);
    tx.sign([keypair]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log(`  Closed: ${sig}`);
  }

  console.log("Writing route buffer...");
  const writeBufferArgs = encodeWriteRouteBufferArgs(
    routeTemplate,
    tokensAmountOffset,
    calldataAmountOffset,
  );
  const writeBufferIx = new TransactionInstruction({
    programId: SWAP_INTENT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: routeBufferPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([WRITE_ROUTE_BUFFER_DISCRIMINATOR, writeBufferArgs]),
  });

  {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [writeBufferIx],
    }).compileToV0Message([]);
    const tx = new VersionedTransaction(msg);
    tx.sign([keypair]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log(`  Confirmed: ${sig}`);
  }
  console.log();

  // ─── Tx 1: open + Jupiter swap ─────────────────────────────────────────
  console.log("Sending Tx 1: open + Jupiter swap...");

  const openIx = new TransactionInstruction({
    programId: SWAP_INTENT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userUsdcAta, isSigner: false, isWritable: false },
      { pubkey: swapStatePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: OPEN_DISCRIMINATOR,
  });

  const jupiterInstructions: TransactionInstruction[] = [
    ...jupiterIxs.setupInstructions.map(jupiterIxToInstruction),
    jupiterIxToInstruction(jupiterIxs.swapInstruction),
    ...(jupiterIxs.cleanupInstruction
      ? [jupiterIxToInstruction(jupiterIxs.cleanupInstruction)]
      : []),
  ];

  {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        openIx,
        ...jupiterInstructions,
      ],
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(msg);
    tx.sign([keypair]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    console.log(`  Signature: ${sig}`);
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log("  Confirmed!");
    console.log(`  Explorer: https://solscan.io/tx/${sig}`);
  }
  console.log();

  // ─── Read actual swap output ─────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 2000));
  const postSwapInfo = await connection.getTokenAccountBalance(
    userUsdcAta,
    "confirmed",
  );
  const postSwapBalance = BigInt(postSwapInfo.value.amount);
  const actualSwapOutput = postSwapBalance - preSwapBalance;

  if (actualSwapOutput <= 0n) {
    console.error(
      `Swap output is ${actualSwapOutput}. Pre: ${preSwapBalance}, Post: ${postSwapBalance}`,
    );
    process.exit(1);
  }

  const actualReward = rewardAmount === 0n ? actualSwapOutput : rewardAmount;
  const routeAmount = (actualSwapOutput * SCALAR_NUM) / SCALAR_DENOM - FLAT_FEE;

  console.log(`Actual swap output: ${actualSwapOutput} USDC`);
  console.log(`Reward amount:      ${actualReward}`);
  console.log(`Route amount:       ${routeAmount}`);
  console.log(`Solver profit:      ${actualReward - routeAmount}`);
  console.log();

  // ─── Compute vault PDA from actual amounts ───────────────────────────────
  const routeHash = computeRouteHash(
    routeTemplate,
    routeAmount,
    tokensAmountOffset,
    calldataAmountOffset,
  );
  const rewardHash = hashReward({
    deadline: rewardDeadline,
    creator: user,
    prover: HYPER_PROVER,
    nativeAmount: 0n,
    tokens: [{ token: USDC_MINT, amount: actualReward }],
  });
  const intentHash = computeIntentHash(BASE_CHAIN_ID, routeHash, rewardHash);

  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, intentHash],
    PORTAL_PROGRAM,
  );
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vault, true);

  console.log(`Intent hash: ${intentHash.toString("hex")}`);
  console.log(`Vault PDA:   ${vault.toBase58()}`);
  console.log();

  // ─── Tx 2: close_and_create_intent ───────────────────────────────────────
  console.log("Sending Tx 2: close_and_create_intent...");

  const closeArgs = encodeCreateIntentArgs({
    destination: BASE_CHAIN_ID,
    rewardDeadline,
    rewardCreator: user,
    rewardProver: HYPER_PROVER,
    rewardToken: USDC_MINT,
    rewardAmount,
    flatFee: FLAT_FEE,
    scalarNum: SCALAR_NUM,
    scalarDenom: SCALAR_DENOM,
    sourceDecimals: SOURCE_DECIMALS,
    destinationDecimals: DESTINATION_DECIMALS,
    allowPartial: false,
  });

  const closeIx = new TransactionInstruction({
    programId: SWAP_INTENT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: swapStatePda, isSigner: false, isWritable: true },
      { pubkey: routeBufferPda, isSigner: false, isWritable: true },
      { pubkey: userUsdcAta, isSigner: false, isWritable: false },
      { pubkey: PORTAL_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: userUsdcAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([CLOSE_DISCRIMINATOR, closeArgs]),
  });

  {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        closeIx,
      ],
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(msg);
    tx.sign([keypair]);
    const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
    console.log(`  Signature: ${signature}`);
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log("  Confirmed!");
    console.log();
    console.log(`Explorer: https://solscan.io/tx/${signature}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
