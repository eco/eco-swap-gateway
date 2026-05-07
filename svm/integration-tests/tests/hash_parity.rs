//! Deterministic hash parity golden.
//!
//! Pins the output of the off-chain + on-chain hashers for a fixed fixture.
//! The TS equivalent at `svm/script/src/hashParity.test.ts` asserts the same
//! golden hex values — any drift in either encoder flags here first.

use eco_svm_std::Bytes32;
use eco_swap_gateway::types::Bucket;
use portal::types::{intent_hash as compute_intent_hash, Call, Reward, Route, TokenAmount};
use solana_sdk::pubkey::Pubkey;

const DESTINATION: u64 = 8453;

fn fixture_reward() -> Reward {
    Reward {
        deadline: 1_700_000_000,
        creator: Pubkey::new_from_array([2u8; 32]),
        prover: Pubkey::new_from_array([3u8; 32]),
        native_amount: 0,
        tokens: vec![TokenAmount {
            token: Pubkey::new_from_array([1u8; 32]),
            amount: 100,
        }],
    }
}

fn fixture_route(amount: u64) -> Route {
    Route {
        salt: [4u8; 32].into(),
        deadline: 1_700_000_000,
        portal: [5u8; 32].into(),
        native_amount: 0,
        tokens: vec![TokenAmount {
            token: Pubkey::new_from_array([1u8; 32]),
            amount: amount,
        }],
        calls: vec![Call {
            target: [6u8; 32].into(),
            data: vec![0xAAu8; 32],
        }],
    }
}

fn fixture_buckets() -> Vec<Bucket> {
    vec![
        Bucket {
            route_hash: fixture_route(100).hash(),
            reward_amount: 100,
        },
        Bucket {
            route_hash: fixture_route(200).hash(),
            reward_amount: 200,
        },
    ]
}

fn hex(b: &Bytes32) -> String {
    let arr: [u8; 32] = (*b).into();
    arr.iter().map(|x| format!("{:02x}", x)).collect()
}

// ─── Golden values ─────────────────────────────────────────────────────────
// Regenerate by running the `print_goldens` test with `--nocapture` when any
// encoder changes, then update the TS side at `svm/script/src/hashParity.test.ts`.

const REWARD_HASH_HEX: &str =
    "8af572ac3d774567f11617bad36b815333064ad56168e1aec5b1683e7c98bd96";
const ROUTE_0_HASH_HEX: &str =
    "a3f050c1003e4c3ae7c168bfc06662dd9d6fa05a3056fb4b04d4e3a5db651db7";
const INTENT_HASH_HEX: &str =
    "9a0253853ca6693d5b45e310849ab6697392fb2f076a400abba325c7cfe0e0a7";

#[test]
#[ignore]
fn print_goldens() {
    let reward = fixture_reward();
    let route0 = fixture_route(100);
    let buckets = fixture_buckets();
    let intent_hash = compute_intent_hash(
        DESTINATION,
        &buckets[0].route_hash,
        &reward.hash(),
    );

    println!("reward_hash:  0x{}", hex(&reward.hash()));
    println!("route_0_hash: 0x{}", hex(&route0.hash()));
    println!("intent_hash:  0x{}", hex(&intent_hash));
}

#[test]
fn reward_hash_stable() {
    assert_eq!(hex(&fixture_reward().hash()), REWARD_HASH_HEX);
}

#[test]
fn route_hash_stable() {
    assert_eq!(hex(&fixture_route(100).hash()), ROUTE_0_HASH_HEX);
}

#[test]
fn intent_hash_stable() {
    let reward = fixture_reward();
    let buckets = fixture_buckets();
    let ih = compute_intent_hash(DESTINATION, &buckets[0].route_hash, &reward.hash());
    assert_eq!(hex(&ih), INTENT_HASH_HEX);
}
