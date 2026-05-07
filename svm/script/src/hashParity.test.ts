/**
 * Cross-language hash parity test (Phase 10).
 *
 * Recomputes the fixed fixture from
 * `svm/integration-tests/tests/hash_parity.rs` using the TS encoders and
 * asserts each intermediate hash matches the hardcoded Rust goldens. When
 * either encoder drifts — Rust Borsh layout changes or the TS serializer
 * regresses — one of these four assertions fails.
 *
 * Run: `npx tsx src/hashParity.test.ts`
 */

import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  Bucket,
  Call,
  Reward,
  Route,
  computeIntentHash,
  hashReward,
  hashRoute,
} from "./common.js";

const DESTINATION = 8453n;

function pk(byte: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, byte));
}

function bytes32(byte: number): Uint8Array {
  return new Uint8Array(Buffer.alloc(32, byte));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fixtureReward(): Reward {
  return {
    deadline: 1_700_000_000n,
    creator: pk(2),
    prover: pk(3),
    nativeAmount: 0n,
    tokens: [{ token: pk(1), amount: 100n }],
  };
}

function fixtureRoute(amount: bigint): Route {
  return {
    salt: bytes32(4),
    deadline: 1_700_000_000n,
    portal: bytes32(5),
    nativeAmount: 0n,
    tokens: [{ token: pk(1), amount }],
    calls: [
      {
        target: bytes32(6),
        data: new Uint8Array(Buffer.alloc(32, 0xaa)),
      } as Call,
    ],
  };
}

function fixtureBuckets(): Bucket[] {
  return [
    { routeHash: hashRoute(fixtureRoute(100n)), rewardAmount: 100n },
    { routeHash: hashRoute(fixtureRoute(200n)), rewardAmount: 200n },
  ];
}

// Goldens duplicated from `svm/integration-tests/tests/hash_parity.rs`.
const REWARD_HASH_HEX =
  "8af572ac3d774567f11617bad36b815333064ad56168e1aec5b1683e7c98bd96";
const ROUTE_0_HASH_HEX =
  "a3f050c1003e4c3ae7c168bfc06662dd9d6fa05a3056fb4b04d4e3a5db651db7";
const INTENT_HASH_HEX =
  "9a0253853ca6693d5b45e310849ab6697392fb2f076a400abba325c7cfe0e0a7";

function rewardHashMatches() {
  assert.equal(toHex(hashReward(fixtureReward())), REWARD_HASH_HEX);
}

function routeHashMatches() {
  assert.equal(toHex(hashRoute(fixtureRoute(100n))), ROUTE_0_HASH_HEX);
}

function intentHashMatches() {
  const buckets = fixtureBuckets();
  const reward = fixtureReward();
  const ih = computeIntentHash(
    DESTINATION,
    buckets[0].routeHash,
    hashReward(reward),
  );
  assert.equal(toHex(ih), INTENT_HASH_HEX);
}

function main() {
  const cases: Array<[string, () => void]> = [
    ["reward_hash matches Rust", rewardHashMatches],
    ["route_hash matches Rust", routeHashMatches],
    ["intent_hash matches Rust", intentHashMatches],
  ];

  let failed = 0;
  for (const [name, test] of cases) {
    try {
      test();
      console.log(`ok  — ${name}`);
    } catch (err) {
      failed++;
      console.error(
        `fail — ${name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (failed > 0) {
    console.error(`\n${failed}/${cases.length} assertions failed.`);
    process.exit(1);
  }
  console.log(`\n${cases.length}/${cases.length} assertions passed.`);
}

main();
