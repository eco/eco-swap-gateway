use anchor_lang::prelude::*;
use anchor_lang::AnchorSerialize;
use eco_svm_std::Bytes32;
use portal::types::Reward;
use tiny_keccak::{Hasher, Keccak};

use crate::errors::GatewayError;
use crate::types::{Bucket, MAX_BUCKETS};

/// Reward-template invariants shared by both the SPL and native flows.
/// Shape-specific checks (`native_amount` placeholder, tokens count, mint
/// match) live in the per-handler `validate_base_reward` / `validate_base_reward_native`.
pub fn validate_base_reward_common(reward: &Reward) -> Result<()> {
    require!(
        reward.creator != Pubkey::default(),
        GatewayError::InvalidRewardCreator
    );
    require!(
        reward.prover != Pubkey::default(),
        GatewayError::InvalidRewardProver
    );
    Ok(())
}

/// Single-pass bucket validation + floor selection. Verifies non-empty,
/// length cap, ascending order, and that the user-signed `buckets_hash`
/// matches `keccak(borsh(buckets))`. Returns the floor-selected index `k`
/// along with its `reward_amount`, `route_hash`, and the recomputed
/// `buckets_hash` (so the caller can emit it without rehashing).
///
/// `delta` must already be computed by the caller (it depends on accounts
/// the helper doesn't see — the user's reward ATA balance and the
/// snapshot's `pre_balance`).
pub fn validate_buckets_and_pick(
    buckets: &[Bucket],
    buckets_hash: Bytes32,
    delta: u64,
) -> Result<(usize, u64, Bytes32, Bytes32)> {
    require!(
        !buckets.is_empty() && buckets.len() <= MAX_BUCKETS,
        GatewayError::InvalidBucketCount
    );
    require!(delta > 0, GatewayError::ZeroDelta);
    require!(
        delta >= buckets[0].reward_amount,
        GatewayError::DeltaBelowFloor
    );

    let computed_hash: Bytes32 = keccak_buckets(buckets)?.into();
    require!(
        computed_hash == buckets_hash,
        GatewayError::BucketsHashMismatch
    );

    let mut k: usize = 0;
    let mut prev = buckets[0].reward_amount;
    for (i, b) in buckets.iter().enumerate().skip(1) {
        require!(b.reward_amount > prev, GatewayError::BucketsNotAscending);
        if b.reward_amount <= delta {
            k = i;
        }
        prev = b.reward_amount;
    }

    Ok((k, buckets[k].reward_amount, buckets[k].route_hash, computed_hash))
}

/// Borsh-serialize `Vec<Bucket>` (length-prefixed) and Keccak-256 hash.
/// Off-chain builders must produce the same bytes.
fn keccak_buckets(buckets: &[Bucket]) -> Result<[u8; 32]> {
    let encoded = buckets.to_vec().try_to_vec()?;
    let mut hasher = Keccak::v256();
    hasher.update(&encoded);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    Ok(out)
}
