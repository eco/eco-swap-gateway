use anchor_lang::prelude::*;
use derive_new::new;
use eco_svm_std::Bytes32;

#[event]
#[derive(new)]
pub struct IntentCreated {
    pub intent_hash: Bytes32,
    pub user: Pubkey,
    pub destination: u64,
}

#[event]
#[derive(new)]
pub struct RouteBufferCreated {
    pub user: Pubkey,
}

#[event]
#[derive(new)]
pub struct RouteBufferClosed {
    pub user: Pubkey,
}
