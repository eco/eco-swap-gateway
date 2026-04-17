use anchor_lang::prelude::*;

pub const SWAP_STATE_SEED: &[u8] = b"swap_state";
pub const ROUTE_BUFFER_SEED: &[u8] = b"route_buffer";

pub fn swap_state_pda(user: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SWAP_STATE_SEED, user.as_ref()], &crate::ID)
}

pub fn route_buffer_pda(user: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ROUTE_BUFFER_SEED, user.as_ref()], &crate::ID)
}

#[account]
#[derive(InitSpace)]
pub struct SwapState {
    pub user: Pubkey,
    pub output_token_account: Pubkey,
    pub output_mint: Pubkey,
    pub pre_balance: u64,
    pub bump: u8,
}

/// Pre-populated buffer storing the ABI-encoded route template and patch offsets.
/// Created in a setup transaction, consumed and closed by close_and_create_intent.
/// This keeps the route template (~608 bytes) out of instruction data, enabling
/// the main transaction (open + swap + close) to fit in a single 1232-byte tx.
#[account]
#[derive(InitSpace)]
pub struct RouteBuffer {
    pub user: Pubkey,
    pub tokens_amount_offset: u32,
    pub calldata_amount_offset: u32,
    #[max_len(1024)]
    pub route_data: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_state_pda_deterministic() {
        let user = Pubkey::new_from_array([42u8; 32]);
        goldie::assert_json!(swap_state_pda(&user));
    }

    #[test]
    fn route_buffer_pda_deterministic() {
        let user = Pubkey::new_from_array([42u8; 32]);
        goldie::assert_json!(route_buffer_pda(&user));
    }
}
