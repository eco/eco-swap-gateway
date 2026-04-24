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

const VAULT_SEED = Buffer.from("vault");
const SNAP_SEED = Buffer.from("snap");

// Anchor `global:<name>` discriminators (sha256 prefix).
export const DISCRIMINATOR = {
  open: anchorDiscriminator("open"),
  close_and_select_intent: anchorDiscriminator("close_and_select_intent"),
  publish: anchorDiscriminator("publish"),
  fund: anchorDiscriminator("fund"),
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
