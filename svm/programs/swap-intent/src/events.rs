use anchor_lang::prelude::*;
use derive_new::new;
use eco_svm_std::Bytes32;

#[event]
#[derive(new)]
pub struct IntentCreated {
    pub intent_hash: Bytes32,
    pub user: Pubkey,
    pub reward_token: Pubkey,
    pub swap_output: u64,
    pub route_amount: u128,
    pub destination: u64,
}

#[event]
#[derive(new)]
pub struct SwapCancelled {
    pub user: Pubkey,
}
