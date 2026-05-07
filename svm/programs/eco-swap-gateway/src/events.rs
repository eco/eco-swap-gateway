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
}

/// Emitted after the selected bucket's reward is transferred into the intent
/// vault's ATA. Mirrors `portal::IntentFunded`'s field shape so off-chain
/// indexers can subscribe to both programs with one schema.
#[event]
#[derive(new)]
pub struct IntentFunded {
    pub intent_hash: Bytes32,
    pub funder: Pubkey,
    pub complete: bool,
}
