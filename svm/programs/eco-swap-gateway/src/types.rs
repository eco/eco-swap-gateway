use anchor_lang::prelude::*;
use eco_svm_std::Bytes32;
use portal::types::Reward;

/// Solver-claimed, strictly-ascending-by-`reward_amount` candidate intent.
///
/// `route_hash` must have been the subject of a prior `Portal::publish` call;
/// on-chain validation here only enforces ordering and floor-selection — the
/// frontend/wallet is expected to verify each `route_hash` against an indexed
/// `IntentPublished` event before the user signs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bucket {
    pub route_hash: Bytes32,
    pub reward_amount: u64,
}

/// Bucket list cap driven by instruction-data size (see DESIGN.md §"Account
/// budget (SVM)"). Hard upper bound for `buckets.len()` validation.
pub const MAX_BUCKETS: usize = 14;

#[derive(AnchorSerialize, AnchorDeserialize, Debug)]
pub struct CloseAndSelectArgs {
    pub destination: u64,
    pub base_reward: Reward,
    pub buckets: Vec<Bucket>,
    pub buckets_hash: Bytes32,
}
