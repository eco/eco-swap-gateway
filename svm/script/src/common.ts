/**
 * SVM-native helpers for the EcoSwapGateway bucketed flow.
 *
 * Pure types, Borsh schemas, hashes, PDA derivations, and Anchor-ix encoders.
 * No network or destination-chain concerns live here — that's `bucketedSwap.ts`.
 *
 * This module is the reference the Phase 10 hash-parity test locks against;
 * any drift in encoding surfaces there first.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "node:crypto";
import * as borsh from "borsh";
import { keccak_256 } from "@noble/hashes/sha3";

// ── Program constants ─────────────────────────────────────────────────────

export const PORTAL_PROGRAM_ID = new PublicKey(
  "Ecoo5HDM2XCBy7QzkhDGrAmnRcWw7emU6xGr7CcCmooo",
);

export const ECO_SWAP_GATEWAY_PROGRAM_ID = new PublicKey(
  "EcoS9WNe7onaxkS9STYMHhUKsvjQGte1eitKhXCpvSPi",
);

export const FLASH_FULFILLER_PROGRAM_ID = new PublicKey(
  "EcoFvY9tDz6kaxAQxNHga68sQm535DskDBCgKm3tziaT",
);

/// Mainnet deployment — differs from `local_prover`'s `declare_id!` in its
/// crate source, which reflects the devnet / `no-mainnet-feature` build.
export const LOCAL_PROVER_PROGRAM_ID = new PublicKey(
  "EcoPZL6PoZ5zHUUpmJLfux1jw126W7jhBB8zrVaFaK1y",
);

/// Matches `eco_svm_std::CHAIN_ID` under the `mainnet` feature.
export const CHAIN_ID_SOLANA = 1399811149n;

const VAULT_SEED = Buffer.from("vault");
const SNAP_SEED = Buffer.from("snap");
const EXECUTOR_SEED = Buffer.from("executor");
const CLAIMED_MARKER_SEED = Buffer.from("claimed_marker"); // used by WithdrawnMarker::pda
const FULFILL_MARKER_SEED = Buffer.from("fulfill_marker");
const PROOF_CLOSER_SEED = Buffer.from("proof_closer");
const PROOF_SEED = Buffer.from("proof");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");
const FLASH_VAULT_SEED = Buffer.from("flash_vault");
const FLASH_FULFILL_INTENT_SEED = Buffer.from("flash_fulfill_intent");

// Anchor `global:<name>` discriminators (sha256 prefix).
export const DISCRIMINATOR = {
  open: anchorDiscriminator("open"),
  close_and_select_intent: anchorDiscriminator("close_and_select_intent"),
  publish: anchorDiscriminator("publish"),
  fund: anchorDiscriminator("fund"),
  init_flash_fulfill_intent: anchorDiscriminator("init_flash_fulfill_intent"),
  append_flash_fulfill_route_chunk: anchorDiscriminator(
    "append_flash_fulfill_route_chunk",
  ),
  flash_fulfill: anchorDiscriminator("flash_fulfill"),
};

// ── Types (mirror the Rust definitions) ───────────────────────────────────

export interface TokenAmount {
  token: PublicKey;
  amount: bigint;
}

export interface Reward {
  deadline: bigint;
  creator: PublicKey;
  prover: PublicKey;
  nativeAmount: bigint;
  tokens: TokenAmount[];
}

export interface Bucket {
  routeHash: Uint8Array; // 32 bytes
  rewardAmount: bigint;
}

export interface Call {
  target: Uint8Array; // 32 bytes
  data: Uint8Array;
}

export interface Route {
  salt: Uint8Array; // 32 bytes
  deadline: bigint;
  portal: Uint8Array; // 32 bytes
  nativeAmount: bigint;
  tokens: TokenAmount[];
  calls: Call[];
}

// ── Borsh schemas ────────────────────────────────────────────────────────

const TOKEN_AMOUNT_SCHEMA: borsh.Schema = {
  struct: { token: { array: { type: "u8", len: 32 } }, amount: "u64" },
};

const REWARD_SCHEMA: borsh.Schema = {
  struct: {
    deadline: "u64",
    creator: { array: { type: "u8", len: 32 } },
    prover: { array: { type: "u8", len: 32 } },
    nativeAmount: "u64",
    tokens: { array: { type: TOKEN_AMOUNT_SCHEMA } },
  },
};

const BUCKET_SCHEMA: borsh.Schema = {
  struct: {
    routeHash: { array: { type: "u8", len: 32 } },
    rewardAmount: "u64",
  },
};

const BUCKETS_SCHEMA: borsh.Schema = { array: { type: BUCKET_SCHEMA } };

const ROUTE_SCHEMA: borsh.Schema = {
  struct: {
    salt: { array: { type: "u8", len: 32 } },
    deadline: "u64",
    portal: { array: { type: "u8", len: 32 } },
    nativeAmount: "u64",
    tokens: { array: { type: TOKEN_AMOUNT_SCHEMA } },
    calls: {
      array: {
        type: {
          struct: {
            target: { array: { type: "u8", len: 32 } },
            data: { array: { type: "u8" } },
          },
        },
      },
    },
  },
};

const CLOSE_AND_SELECT_ARGS_SCHEMA: borsh.Schema = {
  struct: {
    destination: "u64",
    baseReward: REWARD_SCHEMA,
    buckets: { array: { type: BUCKET_SCHEMA } },
    bucketsHash: { array: { type: "u8", len: 32 } },
  },
};

const PUBLISH_ARGS_SCHEMA: borsh.Schema = {
  struct: {
    destination: "u64",
    route: { array: { type: "u8" } },
    reward: REWARD_SCHEMA,
  },
};

// ── Serialization helpers ─────────────────────────────────────────────────

function rewardForBorsh(reward: Reward): unknown {
  return {
    deadline: reward.deadline,
    creator: reward.creator.toBytes(),
    prover: reward.prover.toBytes(),
    nativeAmount: reward.nativeAmount,
    tokens: reward.tokens.map((t) => ({
      token: t.token.toBytes(),
      amount: t.amount,
    })),
  };
}

export function encodeReward(reward: Reward): Uint8Array {
  return borsh.serialize(REWARD_SCHEMA, rewardForBorsh(reward));
}

export function encodeBuckets(buckets: Bucket[]): Uint8Array {
  return borsh.serialize(
    BUCKETS_SCHEMA,
    buckets.map((b) => ({
      routeHash: b.routeHash,
      rewardAmount: b.rewardAmount,
    })),
  );
}

export function encodeRoute(route: Route): Uint8Array {
  return borsh.serialize(ROUTE_SCHEMA, {
    salt: route.salt,
    deadline: route.deadline,
    portal: route.portal,
    nativeAmount: route.nativeAmount,
    tokens: route.tokens.map((t) => ({
      token: t.token.toBytes(),
      amount: t.amount,
    })),
    calls: route.calls.map((c) => ({ target: c.target, data: c.data })),
  });
}

// ── Hash helpers ──────────────────────────────────────────────────────────

function keccakBytes(buf: Uint8Array): Uint8Array {
  return keccak_256(buf);
}

/** Hash an SVM-native Reward. Matches `Reward::hash()` in the Rust Portal. */
export function hashReward(reward: Reward): Uint8Array {
  return keccakBytes(encodeReward(reward));
}

/** Hash an SVM-native Route. Matches `Route::hash()` in the Rust Portal. */
export function hashRoute(route: Route): Uint8Array {
  return keccakBytes(encodeRoute(route));
}

/**
 * `keccak(borsh(Vec<Bucket>))` — the on-chain `keccak_buckets` computes this,
 * and `close_and_select_intent` reverts with `BucketsHashMismatch` if the
 * hash passed in args doesn't equal this computation over the bucket list.
 */
export function computeBucketsHash(buckets: Bucket[]): Uint8Array {
  return keccakBytes(encodeBuckets(buckets));
}

/**
 * `keccak(destination_be || route_hash || reward_hash)` — matches
 * `portal::types::intent_hash` regardless of destination encoding.
 */
export function computeIntentHash(
  destination: bigint,
  routeHash: Uint8Array,
  rewardHash: Uint8Array,
): Uint8Array {
  const destBe = Buffer.alloc(8);
  destBe.writeBigUInt64BE(destination);
  const out = new Uint8Array(72);
  out.set(destBe, 0);
  out.set(routeHash, 8);
  out.set(rewardHash, 40);
  return keccakBytes(out);
}

// ── PDA helpers ───────────────────────────────────────────────────────────

export function vaultPda(intentHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, Buffer.from(intentHash)],
    PORTAL_PROGRAM_ID,
  );
}

export function snapshotPda(userRewardAta: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SNAP_SEED, userRewardAta.toBuffer()],
    ECO_SWAP_GATEWAY_PROGRAM_ID,
  );
}

export function vaultAta(
  vaultPdaPk: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, vaultPdaPk, true, tokenProgram);
}

// ── Instruction builders ─────────────────────────────────────────────────

function anchorDiscriminator(name: string): Buffer {
  const sha = createHash("sha256").update(`global:${name}`).digest();
  return sha.subarray(0, 8);
}

export function buildOpenInstruction(
  user: PublicKey,
  userRewardAta: PublicKey,
): TransactionInstruction {
  const [snapshot] = snapshotPda(userRewardAta);
  return new TransactionInstruction({
    programId: ECO_SWAP_GATEWAY_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userRewardAta, isSigner: false, isWritable: false },
      { pubkey: snapshot, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATOR.open,
  });
}

export interface CloseAndSelectAccounts {
  user: PublicKey;
  userRewardAta: PublicKey;
  sweepRecipientAta: PublicKey;
  mint: PublicKey;
}

export interface CloseAndSelectArgs {
  destination: bigint;
  baseReward: Reward;
  buckets: Bucket[];
}

export function buildCloseAndSelectInstruction(
  accounts: CloseAndSelectAccounts,
  args: CloseAndSelectArgs,
  vaultPairs: Array<{ vaultPda: PublicKey; vaultAta: PublicKey }>,
): TransactionInstruction {
  const [snapshot] = snapshotPda(accounts.userRewardAta);
  const bucketsHash = computeBucketsHash(args.buckets);

  const argsBytes = borsh.serialize(CLOSE_AND_SELECT_ARGS_SCHEMA, {
    destination: args.destination,
    baseReward: rewardForBorsh(args.baseReward),
    buckets: args.buckets.map((b) => ({
      routeHash: b.routeHash,
      rewardAmount: b.rewardAmount,
    })),
    bucketsHash,
  });

  const data = Buffer.concat([
    DISCRIMINATOR.close_and_select_intent,
    argsBytes,
  ]);

  const metas = [
    { pubkey: accounts.user, isSigner: true, isWritable: true },
    { pubkey: accounts.userRewardAta, isSigner: false, isWritable: true },
    { pubkey: snapshot, isSigner: false, isWritable: true },
    { pubkey: accounts.sweepRecipientAta, isSigner: false, isWritable: true },
    { pubkey: accounts.mint, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  for (const { vaultPda: vpda, vaultAta: vata } of vaultPairs) {
    metas.push({ pubkey: vpda, isSigner: false, isWritable: true });
    metas.push({ pubkey: vata, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId: ECO_SWAP_GATEWAY_PROGRAM_ID,
    keys: metas,
    data,
  });
}

/**
 * `Portal::publish` — called post-tx by the Solver for only the winning
 * bucket (see DESIGN.md §Approach for the inversion rationale).
 */
export function buildPublishInstruction(
  publisher: PublicKey,
  destination: bigint,
  route: Uint8Array,
  reward: Reward,
): TransactionInstruction {
  const data = Buffer.concat([
    DISCRIMINATOR.publish,
    borsh.serialize(PUBLISH_ARGS_SCHEMA, {
      destination,
      route,
      reward: rewardForBorsh(reward),
    }),
  ]);

  // The Publish accounts struct in the portal crate is empty (publish.rs:19
  // is `pub struct Publish {}`) — no PDAs, no signer requirement. We still
  // sign the tx with a funded account to pay fees; the account is consumed
  // by the tx envelope, not the ix.
  return new TransactionInstruction({
    programId: PORTAL_PROGRAM_ID,
    keys: [{ pubkey: publisher, isSigner: true, isWritable: true }],
    data,
  });
}

// ── Flash-fulfiller / Portal.fund / Route-call infrastructure ─────────────

const FUND_ARGS_SCHEMA: borsh.Schema = {
  struct: {
    destination: "u64",
    routeHash: { array: { type: "u8", len: 32 } },
    reward: REWARD_SCHEMA,
    allowPartial: "bool",
  },
};

const INIT_FLASH_FULFILL_INTENT_ARGS_SCHEMA: borsh.Schema = {
  struct: {
    intentHash: { array: { type: "u8", len: 32 } },
    routeHash: { array: { type: "u8", len: 32 } },
    reward: REWARD_SCHEMA,
    routeTotalSize: "u32",
  },
};

const APPEND_FLASH_FULFILL_ROUTE_CHUNK_ARGS_SCHEMA: borsh.Schema = {
  struct: {
    intentHash: { array: { type: "u8", len: 32 } },
    offset: "u32",
    chunk: { array: { type: "u8" } },
  },
};

/**
 * `FlashFulfillIntent` is a two-variant enum; we only ever use `IntentHash`.
 * Borsh encodes an enum as `u8` discriminant + variant payload. `IntentHash`
 * is variant 0, payload is the 32-byte hash.
 */
const FLASH_FULFILL_ARGS_SCHEMA: borsh.Schema = {
  struct: {
    intent: {
      enum: [
        {
          struct: { IntentHash: { array: { type: "u8", len: 32 } } },
        },
        {
          struct: {
            Intent: {
              struct: { route: "u8", reward: "u8" /* unused — placeholder */ },
            },
          },
        },
      ],
    },
  },
};

const SERIALIZABLE_ACCOUNT_META_SCHEMA: borsh.Schema = {
  struct: {
    pubkey: { array: { type: "u8", len: 32 } },
    isSigner: "bool",
    isWritable: "bool",
  },
};

const CALLDATA_SCHEMA: borsh.Schema = {
  struct: {
    data: { array: { type: "u8" } },
    accountCount: "u8",
  },
};

const CALLDATA_WITH_ACCOUNTS_SCHEMA: borsh.Schema = {
  struct: {
    calldata: CALLDATA_SCHEMA,
    accounts: { array: { type: SERIALIZABLE_ACCOUNT_META_SCHEMA } },
  },
};

// ── Additional PDA helpers ────────────────────────────────────────────────

export function executorPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([EXECUTOR_SEED], PORTAL_PROGRAM_ID);
}

export function fulfillMarkerPda(intentHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FULFILL_MARKER_SEED, Buffer.from(intentHash)],
    PORTAL_PROGRAM_ID,
  );
}

/**
 * Portal's `WithdrawnMarker` PDA. Despite the name, the seed is
 * `CLAIMED_MARKER_SEED` — see `portal/src/state.rs:36`.
 */
export function withdrawnMarkerPda(
  intentHash: Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CLAIMED_MARKER_SEED, Buffer.from(intentHash)],
    PORTAL_PROGRAM_ID,
  );
}

export function proofCloserPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PROOF_CLOSER_SEED],
    PORTAL_PROGRAM_ID,
  );
}

/**
 * Local-prover's proof account (seeded by the prover program, not portal).
 */
export function proofPda(intentHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PROOF_SEED, Buffer.from(intentHash)],
    LOCAL_PROVER_PROGRAM_ID,
  );
}

export function flashVaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FLASH_VAULT_SEED],
    FLASH_FULFILLER_PROGRAM_ID,
  );
}

export function flashFulfillIntentPda(
  intentHash: Uint8Array,
  writer: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FLASH_FULFILL_INTENT_SEED, Buffer.from(intentHash), writer.toBuffer()],
    FLASH_FULFILLER_PROGRAM_ID,
  );
}

export function eventAuthorityPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], programId);
}

// ── CalldataWithAccounts encoding ────────────────────────────────────────

/**
 * Wrap a Web3 TransactionInstruction as the `CalldataWithAccounts` bytes the
 * flash-fulfiller / portal expect in each `route.calls[i].data`. See
 * `portal/src/types.rs:184` and `flash_fulfiller/src/instructions/flash_fulfill.rs:284`.
 */
export function encodeCalldataWithAccounts(
  ix: TransactionInstruction,
  /**
   * Set of pubkeys (base58-encoded) that WILL be marked writable after
   * Solana's tx-level dedup in the outer flash_fulfill transaction. When
   * present, each key's `isWritable` flag is taken from this set rather
   * than from the ix's own AccountMeta.
   *
   * Portal's `execute_route_calls` reconstructs CalldataWithAccounts from
   * the AccountInfos at CPI time, and Solana's compiler dedups each pubkey
   * once with MAX `is_writable` across all positions. If a pubkey appears
   * writable in ANY ix in the tx, AccountInfo.is_writable is true at every
   * position. Encoding without accounting for dedup causes the committed
   * route hash to differ from portal's reconstruction, triggering
   * `InvalidIntentHash` at `portal/fulfill.rs:71`.
   */
  writablePubkeys?: ReadonlySet<string>,
): Uint8Array {
  if (ix.keys.length > 255) {
    throw new Error(
      `CalldataWithAccounts.account_count is u8; ix has ${ix.keys.length} accounts`,
    );
  }
  return borsh.serialize(CALLDATA_WITH_ACCOUNTS_SCHEMA, {
    calldata: {
      data: Uint8Array.from(ix.data),
      accountCount: ix.keys.length,
    },
    // isSigner MUST be false — PDAs can't sign the outer tx, so Solana's
    // AccountInfo.is_signer is always false at those positions regardless
    // of what the ix's own AccountMeta declared. Portal reconstructs from
    // AccountInfo.is_signer, not the declared ix meta.
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBytes(),
      isSigner: false,
      isWritable: writablePubkeys
        ? writablePubkeys.has(k.pubkey.toBase58())
        : k.isWritable,
    })),
  });
}

// ── Chunking helper ──────────────────────────────────────────────────────

/**
 * Split Route Borsh bytes into append-sized chunks. Default 900B leaves
 * ~330B for ix overhead + 2 accounts + tx framing under the 1232B packet cap.
 */
export function chunkRouteBytes(
  routeBytes: Uint8Array,
  maxChunkBytes = 900,
): Uint8Array[] {
  if (maxChunkBytes <= 0) throw new Error("maxChunkBytes must be > 0");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < routeBytes.length; offset += maxChunkBytes) {
    chunks.push(routeBytes.slice(offset, offset + maxChunkBytes));
  }
  return chunks;
}

// ── Instruction builders (Portal fund + Flash-fulfiller) ─────────────────

export interface PortalFundTransfer {
  /** Source ATA (owned by `funder`). */
  from: PublicKey;
  /** Destination ATA (owned by the vault PDA). */
  to: PublicKey;
  mint: PublicKey;
}

/**
 * Build `portal::fund`. In this script it's used for the post-`flash_fulfill`
 * no-op that re-emits `portal::IntentFunded` — the vault is already funded,
 * so portal computes `need = 0` and skips the transfer (fund_context.rs:86-91)
 * while still emitting the event (fund.rs:70).
 *
 * `payer` is not marked `#[account(mut)]` in the portal crate but its
 * `fund_context` uses it as the ATA-create rent source, so we surface it as
 * writable here.
 */
export function buildPortalFundInstruction(params: {
  payer: PublicKey;
  funder: PublicKey;
  vaultPda: PublicKey;
  destination: bigint;
  routeHash: Uint8Array;
  reward: Reward;
  allowPartial: boolean;
  transfers: PortalFundTransfer[];
}): TransactionInstruction {
  const argsBytes = borsh.serialize(FUND_ARGS_SCHEMA, {
    destination: params.destination,
    routeHash: params.routeHash,
    reward: rewardForBorsh(params.reward),
    allowPartial: params.allowPartial,
  });
  const data = Buffer.concat([DISCRIMINATOR.fund, argsBytes]);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: params.funder, isSigner: true, isWritable: true },
    { pubkey: params.vaultPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (const t of params.transfers) {
    keys.push({ pubkey: t.from, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.to, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.mint, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: PORTAL_PROGRAM_ID,
    keys,
    data,
  });
}

export function buildInitFlashFulfillIntentInstruction(params: {
  writer: PublicKey;
  intentHash: Uint8Array;
  routeHash: Uint8Array;
  reward: Reward;
  routeTotalSize: number;
}): TransactionInstruction {
  const [flashFulfillIntent] = flashFulfillIntentPda(
    params.intentHash,
    params.writer,
  );

  const argsBytes = borsh.serialize(INIT_FLASH_FULFILL_INTENT_ARGS_SCHEMA, {
    intentHash: params.intentHash,
    routeHash: params.routeHash,
    reward: rewardForBorsh(params.reward),
    routeTotalSize: params.routeTotalSize,
  });
  const data = Buffer.concat([
    DISCRIMINATOR.init_flash_fulfill_intent,
    argsBytes,
  ]);

  return new TransactionInstruction({
    programId: FLASH_FULFILLER_PROGRAM_ID,
    keys: [
      { pubkey: params.writer, isSigner: true, isWritable: true },
      { pubkey: flashFulfillIntent, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildAppendFlashFulfillRouteChunkInstruction(params: {
  writer: PublicKey;
  intentHash: Uint8Array;
  offset: number;
  chunk: Uint8Array;
}): TransactionInstruction {
  const [flashFulfillIntent] = flashFulfillIntentPda(
    params.intentHash,
    params.writer,
  );

  const argsBytes = borsh.serialize(
    APPEND_FLASH_FULFILL_ROUTE_CHUNK_ARGS_SCHEMA,
    {
      intentHash: params.intentHash,
      offset: params.offset,
      chunk: params.chunk,
    },
  );
  const data = Buffer.concat([
    DISCRIMINATOR.append_flash_fulfill_route_chunk,
    argsBytes,
  ]);

  return new TransactionInstruction({
    programId: FLASH_FULFILLER_PROGRAM_ID,
    keys: [
      { pubkey: params.writer, isSigner: true, isWritable: false },
      { pubkey: flashFulfillIntent, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Reward/route transfer triple: (intent_vault_ata, flash_vault_ata, mint) for reward;
 *  (flash_vault_ata, executor_ata, mint) for route. Order matches
 *  `flash_fulfill.rs:220-223` / `extract_flash_fulfill_accounts`. */
export interface FlashFulfillTransferTriple {
  from: PublicKey;
  to: PublicKey;
  mint: PublicKey;
}

/**
 * Build `flash_fulfiller::flash_fulfill` with the `IntentHash` variant.
 *
 * Remaining-accounts layout (see `flash_fulfill.rs:98-101`):
 *   [ reward triples... , route triples... , claimant ATAs... , route call accounts... ]
 */
export function buildFlashFulfillInstruction(params: {
  payer: PublicKey;
  flashVault: PublicKey;
  flashFulfillIntent: PublicKey;
  claimant: PublicKey;
  proof: PublicKey;
  intentVault: PublicKey;
  withdrawnMarker: PublicKey;
  proofCloser: PublicKey;
  executor: PublicKey;
  fulfillMarker: PublicKey;
  portalProgram: PublicKey;
  localProverProgram: PublicKey;
  localProverEventAuthority: PublicKey;
  flashFulfillerEventAuthority: PublicKey;
  intentHash: Uint8Array;
  rewardTransfers: FlashFulfillTransferTriple[];
  routeTransfers: FlashFulfillTransferTriple[];
  claimantAtas: PublicKey[];
  callAccounts: Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>;
}): TransactionInstruction {
  const argsBytes = borsh.serialize(FLASH_FULFILL_ARGS_SCHEMA, {
    intent: { IntentHash: params.intentHash },
  });
  const data = Buffer.concat([DISCRIMINATOR.flash_fulfill, argsBytes]);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: params.flashVault, isSigner: false, isWritable: true },
    { pubkey: params.flashFulfillIntent, isSigner: false, isWritable: true },
    { pubkey: params.claimant, isSigner: false, isWritable: true },
    { pubkey: params.proof, isSigner: false, isWritable: true },
    { pubkey: params.intentVault, isSigner: false, isWritable: true },
    { pubkey: params.withdrawnMarker, isSigner: false, isWritable: true },
    { pubkey: params.proofCloser, isSigner: false, isWritable: false },
    { pubkey: params.executor, isSigner: false, isWritable: true },
    { pubkey: params.fulfillMarker, isSigner: false, isWritable: true },
    { pubkey: params.portalProgram, isSigner: false, isWritable: false },
    { pubkey: params.localProverProgram, isSigner: false, isWritable: false },
    {
      pubkey: params.localProverEventAuthority,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Anchor `#[event_cpi]` tail: event_authority + program
    {
      pubkey: params.flashFulfillerEventAuthority,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: FLASH_FULFILLER_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  // Remaining accounts — strict ordering per flash_fulfill.rs.
  for (const t of params.rewardTransfers) {
    keys.push({ pubkey: t.from, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.to, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.mint, isSigner: false, isWritable: false });
  }
  for (const t of params.routeTransfers) {
    keys.push({ pubkey: t.from, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.to, isSigner: false, isWritable: true });
    keys.push({ pubkey: t.mint, isSigner: false, isWritable: false });
  }
  for (const ata of params.claimantAtas) {
    keys.push({ pubkey: ata, isSigner: false, isWritable: true });
  }
  // Route-call accounts: the executor-PDA-as-signer flag lives in the
  // per-call CalldataWithAccounts payload (portal's `invoke_signed` reads
  // it from there). At the outer tx level those accounts must be marked
  // `isSigner: false` — we can't produce signatures for PDAs here.
  for (const acc of params.callAccounts) {
    keys.push({
      pubkey: acc.pubkey,
      isSigner: false,
      isWritable: acc.isWritable,
    });
  }

  return new TransactionInstruction({
    programId: FLASH_FULFILLER_PROGRAM_ID,
    keys,
    data,
  });
}
