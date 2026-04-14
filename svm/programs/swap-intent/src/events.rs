use anchor_lang::prelude::*;
use derive_new::new;
use eco_svm_std::Bytes32;

#[event]
#[derive(new)]
pub struct IntentCreated {
    pub intent_hash: Bytes32,
    pub swap_output: u64,
    pub route_amount: u64,
    pub destination: u64,
}
