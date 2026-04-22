use anchor_lang::prelude::*;
use derive_new::new;
use eco_svm_std::Bytes32;

#[event]
#[derive(new)]
pub struct IntentSelected {
    pub intent_hash: Bytes32,
    pub user: Pubkey,
    pub delta: u64,
    pub bucket_index: u64,
    pub reward_amount: u64,
    pub buckets_hash: Bytes32,
}
