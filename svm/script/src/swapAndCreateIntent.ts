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

const FARTCOIN_AMOUNT = 1_000_000n; // 1M Fartcoin (adjusted by decimals below)
const FARTCOIN_DECIMALS = 6;

// ─── Constants ─────────────────────────────────────────────────────────────

// Solana addresses
const FARTCOIN_MINT = new PublicKey(
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
);
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SWAP_INTENT_PROGRAM = new PublicKey(
  "BZLuymGnjM1BEA7gnerqKm47c1o7a1q3xTb3G1dei8Bk",
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
const OPEN_DISCRIMINATOR = Buffer.from([228, 220, 155, 71, 199, 189, 60, 45]);
const CLOSE_DISCRIMINATOR = Buffer.from([122, 166, 202, 12, 24, 110, 189, 7]);

// PDA seeds
const SWAP_STATE_SEED = Buffer.from("swap_state");
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

// ─── Borsh Encoding for CreateIntentArgs ───────────────────────────────────

function encodeCreateIntentArgs(args: {
  destination: bigint;
  routeTemplate: Buffer;
  tokensAmountOffset: number;
  calldataAmountOffset: number;
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
  extraCalls: Array<{ target: Buffer; data: Buffer }>;
}): Buffer {
  const parts: Buffer[] = [
    writeU64LE(args.destination),
    // route_template: Vec<u8>
    writeU32LE(args.routeTemplate.length),
    args.routeTemplate,
    // offsets: u32 LE
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(args.tokensAmountOffset);
      return b;
    })(),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(args.calldataAmountOffset);
      return b;
    })(),
    // reward fields
    writeU64LE(args.rewardDeadline),
    args.rewardCreator.toBuffer(),
    args.rewardProver.toBuffer(),
    args.rewardToken.toBuffer(),
    // reward_amount: u64 (0 = use full swap_output)
    writeU64LE(args.rewardAmount),
    // fee params
    writeU64LE(args.flatFee),
    writeU64LE(args.scalarNum),
    writeU64LE(args.scalarDenom),
    // decimal config
    Buffer.from([args.sourceDecimals]),
    Buffer.from([args.destinationDecimals]),
    // allow_partial: bool
    Buffer.from([args.allowPartial ? 1 : 0]),
    // extra_calls: Vec<EvmCall>
    writeU32LE(args.extraCalls.length),
  ];
  for (const call of args.extraCalls) {
    parts.push(call.target); // [u8; 32]
    parts.push(writeU32LE(call.data.length));
    parts.push(call.data);
  }
  return Buffer.concat(parts);
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
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.statusText}`);
  return res.json();
}

async function getJupiterSwapInstructions(
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<JupiterSwapInstructions> {
  const res = await fetch("https://quote-api.jup.ag/v6/swap-instructions", {
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

  const inputAmount = FARTCOIN_AMOUNT * BigInt(10 ** FARTCOIN_DECIMALS);
  const rewardDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);

  console.log(`User:           ${user.toBase58()}`);
  console.log(`Input:          ${FARTCOIN_AMOUNT.toLocaleString()} Fartcoin`);
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

  // 4. Pre-compute amounts, hashes, and PDAs
  // reward_amount = 0 means use full swap_output on-chain
  const rewardAmount = 0n;
  const actualReward = rewardAmount === 0n ? swapOutput : rewardAmount;
  const routeAmount = (swapOutput * SCALAR_NUM) / SCALAR_DENOM - FLAT_FEE;
  console.log(`Swap output:    ${swapOutput}`);
  console.log(
    `Reward amount:  ${actualReward}${rewardAmount === 0n ? " (full swap output)" : ""}`,
  );
  console.log(`Route amount:   ${routeAmount}`);
  console.log(`Solver profit:  ${actualReward - routeAmount}`);
  console.log();

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

  const [swapStatePda] = PublicKey.findProgramAddressSync(
    [SWAP_STATE_SEED, user.toBuffer()],
    SWAP_INTENT_PROGRAM,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, intentHash],
    PORTAL_PROGRAM,
  );
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vault, true);
  const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, user);

  console.log(`Intent hash:    ${intentHash.toString("hex")}`);
  console.log(`Vault PDA:      ${vault.toBase58()}`);
  console.log(`Swap state PDA: ${swapStatePda.toBase58()}`);
  console.log();

  // 5. Build instructions

  // Ix 0: Compute budget
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 600_000,
  });

  // Ix 1: SwapIntent::open
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

  // Ix 2: Jupiter swap (setup + swap + cleanup)
  const jupiterInstructions: TransactionInstruction[] = [
    ...jupiterIxs.setupInstructions.map(jupiterIxToInstruction),
    jupiterIxToInstruction(jupiterIxs.swapInstruction),
    ...(jupiterIxs.cleanupInstruction
      ? [jupiterIxToInstruction(jupiterIxs.cleanupInstruction)]
      : []),
  ];

  // Ix 3: SwapIntent::close_and_create_intent
  const closeArgs = encodeCreateIntentArgs({
    destination: BASE_CHAIN_ID,
    routeTemplate,
    tokensAmountOffset,
    calldataAmountOffset,
    rewardDeadline,
    rewardCreator: user,
    rewardProver: HYPER_PROVER,
    rewardToken: USDC_MINT,
    rewardAmount: rewardAmount,
    flatFee: FLAT_FEE,
    scalarNum: SCALAR_NUM,
    scalarDenom: SCALAR_DENOM,
    sourceDecimals: SOURCE_DECIMALS,
    destinationDecimals: DESTINATION_DECIMALS,
    allowPartial: false,
    extraCalls: [],
  });

  const closeIx = new TransactionInstruction({
    programId: SWAP_INTENT_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: swapStatePda, isSigner: false, isWritable: true },
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
      // remaining_accounts: [from_ata, vault_ata, mint]
      { pubkey: userUsdcAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([CLOSE_DISCRIMINATOR, closeArgs]),
  });

  // 6. Resolve Address Lookup Tables
  const allInstructions = [
    computeBudgetIx,
    openIx,
    ...jupiterInstructions,
    closeIx,
  ];

  const lookupTableAddresses = jupiterIxs.addressLookupTableAddresses.map(
    (addr) => new PublicKey(addr),
  );
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const addr of lookupTableAddresses) {
    const result = await connection.getAddressLookupTable(addr);
    if (result.value) lookupTables.push(result.value);
  }

  // 7. Build and sign versioned transaction
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: allInstructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([keypair]);

  console.log("Sending transaction...");
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`  Signature: ${signature}`);

  // 8. Confirm
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight: (await connection.getLatestBlockhash())
        .lastValidBlockHeight,
    },
    "confirmed",
  );

  if (confirmation.value.err) {
    console.error("Transaction failed:", confirmation.value.err);
    process.exit(1);
  }

  console.log("  Confirmed!");
  console.log();
  console.log(`Explorer: https://solscan.io/tx/${signature}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
