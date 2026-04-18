/**
 * Swap & Publish Intent: Fartcoin → USDC on Solana, then USDC on Base
 *
 * Flow:
 *   Setup tx:  write_route_buffer (stores ~608-byte ABI-encoded route in PDA)
 *   Main tx:   Jupiter swap + create_intent_from_buffer (atomic)
 *
 * The main transaction is atomic — if the swap or intent creation fails,
 * everything reverts. Fee-adjusted amounts are pre-computed off-chain using
 * Jupiter's minimum guaranteed output (after slippage).
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
  AddressLookupTableProgram,
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
  type Hex,
  type Address,
} from "viem";
import { keccak256 as viemKeccak256 } from "viem";
import bs58 from "bs58";

// ─── Configuration ─────────────────────────────────────────────────────────

const FARTCOIN_RAW_AMOUNT = 300_000n; // 0.3 Fartcoin (raw, 6 decimals)
const FARTCOIN_DECIMALS = 6;
const SLIPPAGE_BPS = 300; // 3% slippage for volatile tokens

// ─── Constants ─────────────────────────────────────────────────────────────

// Solana addresses
const FARTCOIN_MINT = new PublicKey(
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
);
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const INTENT_PUBLISHER_PROGRAM = new PublicKey(
  "Ecof7tm19p8THsL3oQLWrUfji7Um47CemibkNSBjxJd3",
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
const SCALAR_DENOM = 10_000n;
const SCALAR_NUM = SCALAR_DENOM - 6n; // 9994
const FLAT_FEE = 10_000n; // $0.01 in 6-decimal USDC

// Instruction discriminators (SHA256("global:<name>")[0:8])
const WRITE_ROUTE_BUFFER_DISCRIMINATOR = Buffer.from([
  75, 235, 140, 42, 51, 248, 84, 98,
]);
const CREATE_INTENT_FROM_BUFFER_DISCRIMINATOR = Buffer.from([
  167, 102, 202, 28, 15, 211, 184, 138,
]);
const CLOSE_ROUTE_BUFFER_DISCRIMINATOR = Buffer.from([
  66, 5, 208, 96, 30, 99, 2, 238,
]);

// PDA seeds
const ROUTE_BUFFER_SEED = Buffer.from("route_buffer");
const VAULT_SEED = Buffer.from("vault");

// On-chain RouteBuffer max capacity
const ROUTE_BUFFER_MAX_LEN = 1024;

// ─── Types ─────────────────────────────────────────────────────────────────

interface Reward {
  deadline: bigint;
  creator: PublicKey;
  prover: PublicKey;
  nativeAmount: bigint;
  tokens: Array<{ token: PublicKey; amount: bigint }>;
}

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

// ─── Route Builder ─────────────────────────────────────────────────────────

/**
 * Build an ABI-encoded route with the actual routeAmount baked in.
 * The route instructs the solver to transfer USDC to the recipient on Base.
 */
function buildRoute(routeAmount: bigint, recipient: Address): Buffer {
  const routeDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
  const salt = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;

  const transferCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, routeAmount],
  });

  const route = {
    salt,
    deadline: routeDeadline,
    portal: PORTAL_BASE,
    nativeAmount: 0n,
    tokens: [{ token: USDC_BASE, amount: routeAmount }],
    calls: [{ target: USDC_BASE, data: transferCalldata, value: 0n }],
  };

  const encoded = encodeAbiParameters([EVMRouteAbiType], [route]);
  return Buffer.from(encoded.slice(2), "hex");
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
 * Borsh-serialize a Reward struct.
 * Must match Portal's Reward Borsh layout exactly.
 *
 * Layout: deadline(u64 LE) + creator(32) + prover(32) + native_amount(u64 LE)
 *         + tokens_len(u32 LE) + [token(32) + amount(u64 LE)]*
 */
function serializeReward(reward: Reward): Buffer {
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
  return Buffer.concat(parts);
}

/** keccak256(borsh(Reward)) — matches Portal's Reward::hash() on-chain */
function hashReward(reward: Reward): Buffer {
  return keccak256(serializeReward(reward));
}

/** intent_hash = keccak256(destination_be8 || route_hash || reward_hash) */
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

/** Encode WriteRouteBufferArgs: { route: Vec<u8> } */
function encodeWriteRouteBufferArgs(route: Buffer): Buffer {
  return Buffer.concat([writeU32LE(route.length), route]);
}

/**
 * Encode CreateIntentFromBufferArgs:
 *   destination: u64, reward: Reward (Borsh), allow_partial: bool
 */
function encodeCreateIntentFromBufferArgs(args: {
  destination: bigint;
  reward: Reward;
  allowPartial: boolean;
}): Buffer {
  return Buffer.concat([
    writeU64LE(args.destination),
    serializeReward(args.reward),
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
  slippageBps: number,
): Promise<JupiterQuote> {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
  }
  return await res.json();
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
      `Jupiter swap-instructions failed (${res.status}): ${body}`,
    );
  }
  return await res.json();
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

// ─── Transaction Helpers ───────────────────────────────────────────────────

async function sendV0Tx(
  connection: Connection,
  keypair: Keypair,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 3 });

  const confirmation = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(
      `Transaction confirmed but FAILED on-chain: ` +
        `${JSON.stringify(confirmation.value.err)}. ` +
        `https://solscan.io/tx/${sig}`,
    );
  }
  return sig;
}

function buildCloseRouteBufferIx(
  user: PublicKey,
  routeBufferPda: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: INTENT_PUBLISHER_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: routeBufferPda, isSigner: false, isWritable: true },
    ],
    data: CLOSE_ROUTE_BUFFER_DISCRIMINATOR,
  });
}

async function resolveLookupTables(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  const tables: AddressLookupTableAccount[] = [];
  for (const addr of addresses) {
    const pubkey = new PublicKey(addr);
    const result = await connection.getAddressLookupTable(pubkey);
    if (!result.value) {
      throw new Error(
        `Failed to resolve Jupiter ALT: ${addr}. Retry with a fresh quote.`,
      );
    }
    tables.push(result.value);
  }
  return tables;
}

// ─── Address Lookup Table ──────────────────────────────────────────────────

/**
 * Static accounts used by intent-publisher that aren't in Jupiter's ALTs.
 * Putting these in an ALT saves ~31 bytes per account in the main tx.
 */
const INTENT_ALT_ADDRESSES = [
  PORTAL_PROGRAM,
  USDC_MINT,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
];

/**
 * Load an existing ALT from INTENT_PUBLISHER_ALT env var, or create one
 * with the static intent-publisher accounts. The ALT is reusable across runs.
 */
async function getOrCreateIntentAlt(
  connection: Connection,
  keypair: Keypair,
): Promise<AddressLookupTableAccount> {
  const altEnv = process.env.INTENT_PUBLISHER_ALT;

  if (altEnv) {
    const result = await connection.getAddressLookupTable(
      new PublicKey(altEnv),
    );
    if (result.value) return result.value;
    console.warn(
      `INTENT_PUBLISHER_ALT ${altEnv} not found on-chain, creating new one...`,
    );
  }

  console.log("Creating intent-publisher ALT (one-time setup)...");
  const slot = await connection.getSlot("finalized");
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: keypair.publicKey,
    payer: keypair.publicKey,
    recentSlot: slot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: keypair.publicKey,
    authority: keypair.publicKey,
    lookupTable: altAddress,
    addresses: INTENT_ALT_ADDRESSES,
  });

  const sig = await sendV0Tx(connection, keypair, [createIx, extendIx]);
  console.log(`  ALT created: ${altAddress.toBase58()}`);
  console.log(`  Tx: ${sig}`);
  console.log(
    `  Add to .env for faster startup: INTENT_PUBLISHER_ALT=${altAddress.toBase58()}`,
  );
  console.log();

  const result = await connection.getAddressLookupTable(altAddress);
  if (!result.value) {
    throw new Error("Failed to fetch newly created ALT");
  }
  return result.value;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var is required");

  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

  const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  const connection = new Connection(rpcUrl, "confirmed");
  const user = keypair.publicKey;

  const rewardDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);

  console.log(`User:           ${user.toBase58()}`);
  console.log(
    `Input:          ${Number(FARTCOIN_RAW_AMOUNT) / 10 ** FARTCOIN_DECIMALS} Fartcoin (${FARTCOIN_RAW_AMOUNT} raw)`,
  );
  console.log(`Swap:           Fartcoin → USDC on Solana (Jupiter)`);
  console.log(`Intent:         USDC on Solana → USDC on Base`);
  console.log();

  // ─── 1. Get Jupiter quote ─────────────────────────────────────────────────

  console.log("Fetching Jupiter quote...");
  const quote = await getJupiterQuote(
    FARTCOIN_MINT.toBase58(),
    USDC_MINT.toBase58(),
    FARTCOIN_RAW_AMOUNT,
    SLIPPAGE_BPS,
  );

  if (!quote.outAmount || !quote.otherAmountThreshold) {
    throw new Error(
      `Jupiter quote missing output amounts: outAmount=${quote.outAmount}, ` +
        `otherAmountThreshold=${quote.otherAmountThreshold}`,
    );
  }
  const expectedOutput = BigInt(quote.outAmount);
  const minOutput = BigInt(quote.otherAmountThreshold);
  if (minOutput === 0n) {
    throw new Error(
      "Jupiter returned 0 for minimum output — quote may be stale or pair is illiquid",
    );
  }

  console.log(`  Expected output:  ${expectedOutput} USDC (raw)`);
  console.log(
    `  Min output:       ${minOutput} USDC (after ${SLIPPAGE_BPS} bps slippage)`,
  );
  console.log();

  // ─── 2. Compute amounts off-chain ─────────────────────────────────────────

  const rewardAmount = minOutput;
  const routeAmount = (rewardAmount * SCALAR_NUM) / SCALAR_DENOM - FLAT_FEE;

  if (routeAmount <= 0n) {
    throw new Error(
      `Route amount is ${routeAmount} — swap output too small to cover fees`,
    );
  }

  console.log(`Reward amount:  ${rewardAmount} USDC (locked in vault)`);
  console.log(`Route amount:   ${routeAmount} USDC (delivered on Base)`);
  console.log(`Solver profit:  ${rewardAmount - routeAmount} USDC`);
  console.log();

  // ─── 3. Build route with actual amounts ───────────────────────────────────

  // Solana pubkey (32 bytes) truncated to 20 bytes for the EVM recipient address.
  // The user must control this address on Base (e.g. derived from the same seed).
  const recipient =
    `0x${Buffer.from(user.toBytes()).toString("hex").slice(0, 40)}` as Address;
  const route = buildRoute(routeAmount, recipient);

  if (route.length > ROUTE_BUFFER_MAX_LEN) {
    throw new Error(
      `Route is ${route.length} bytes but RouteBuffer max is ${ROUTE_BUFFER_MAX_LEN}`,
    );
  }

  console.log(`Route:          ${route.length} bytes`);
  console.log(`Recipient:      ${recipient}`);

  // ─── 4. Compute hashes and derive vault PDA ───────────────────────────────

  const reward: Reward = {
    deadline: rewardDeadline,
    creator: user,
    prover: HYPER_PROVER,
    nativeAmount: 0n,
    tokens: [{ token: USDC_MINT, amount: rewardAmount }],
  };

  const routeHash = keccak256(route);
  const rewardHash = hashReward(reward);
  const intentHash = computeIntentHash(BASE_CHAIN_ID, routeHash, rewardHash);

  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, intentHash],
    PORTAL_PROGRAM,
  );
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vault, true);
  const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, user);

  console.log(`Intent hash:    ${intentHash.toString("hex")}`);
  console.log(`Vault PDA:      ${vault.toBase58()}`);
  console.log();

  // ─── 5. Derive route buffer PDA and load ALT ───────────────────────────────

  const [routeBufferPda] = PublicKey.findProgramAddressSync(
    [ROUTE_BUFFER_SEED, user.toBuffer()],
    INTENT_PUBLISHER_PROGRAM,
  );

  const intentAlt = await getOrCreateIntentAlt(connection, keypair);

  // ─── 6. Cleanup stale route buffer ────────────────────────────────────────

  const existingBuffer = await connection.getAccountInfo(routeBufferPda);
  if (existingBuffer && existingBuffer.lamports > 0) {
    console.log("Closing stale route buffer...");
    const sig = await sendV0Tx(connection, keypair, [
      buildCloseRouteBufferIx(user, routeBufferPda),
    ]);
    console.log(`  Closed: ${sig}`);
    console.log();
  }

  // ─── 7. Setup Tx: write_route_buffer ──────────────────────────────────────

  console.log("Tx 1 (setup): write_route_buffer...");

  const writeBufferIx = new TransactionInstruction({
    programId: INTENT_PUBLISHER_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: routeBufferPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      WRITE_ROUTE_BUFFER_DISCRIMINATOR,
      encodeWriteRouteBufferArgs(route),
    ]),
  });

  const setupSig = await sendV0Tx(connection, keypair, [writeBufferIx]);
  console.log(`  Confirmed: ${setupSig}`);
  console.log();

  // ─── 8. Main Tx: Jupiter swap + create_intent_from_buffer ─────────────────

  console.log("Tx 2 (main): Jupiter swap + create_intent_from_buffer...");

  const jupiterIxs = await getJupiterSwapInstructions(quote, user.toBase58());

  const jupiterInstructions: TransactionInstruction[] = [
    ...jupiterIxs.setupInstructions.map(jupiterIxToInstruction),
    jupiterIxToInstruction(jupiterIxs.swapInstruction),
    ...(jupiterIxs.cleanupInstruction
      ? [jupiterIxToInstruction(jupiterIxs.cleanupInstruction)]
      : []),
  ];

  // Accounts match Anchor struct field order: CreateIntentFromBuffer
  const createIx = new TransactionInstruction({
    programId: INTENT_PUBLISHER_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: routeBufferPda, isSigner: false, isWritable: true },
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
      // remaining_accounts: [from_ata, vault_ata, mint] per reward token
      { pubkey: userUsdcAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      CREATE_INTENT_FROM_BUFFER_DISCRIMINATOR,
      encodeCreateIntentFromBufferArgs({
        destination: BASE_CHAIN_ID,
        reward,
        allowPartial: false,
      }),
    ]),
  });

  const jupiterLookupTables = await resolveLookupTables(
    connection,
    jupiterIxs.addressLookupTableAddresses,
  );
  const lookupTables = [...jupiterLookupTables, intentAlt];

  try {
    const sig = await sendV0Tx(
      connection,
      keypair,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...jupiterInstructions,
        createIx,
      ],
      lookupTables,
    );
    console.log(`  Confirmed: ${sig}`);
    console.log();
    console.log(`Intent hash: ${intentHash.toString("hex")}`);
    console.log(`Explorer:    https://solscan.io/tx/${sig}`);
  } catch (err) {
    // Main tx failed — close the orphaned route buffer to reclaim rent
    console.error(
      "Main transaction failed. Closing route buffer to reclaim rent...",
    );
    try {
      const sig = await sendV0Tx(connection, keypair, [
        buildCloseRouteBufferIx(user, routeBufferPda),
      ]);
      console.log(`  Route buffer closed: ${sig}`);
    } catch {
      console.error(
        `Failed to close route buffer at ${routeBufferPda.toBase58()}. ` +
          `Run the script again to reclaim rent.`,
      );
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
