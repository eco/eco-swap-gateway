use anchor_lang::prelude::*;

pub const SWAP_STATE_SEED: &[u8] = b"swap_state";

pub fn swap_state_pda(user: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SWAP_STATE_SEED, user.as_ref()], &crate::ID)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_state_pda_deterministic() {
        let user = Pubkey::new_from_array([42u8; 32]);
        goldie::assert_json!(swap_state_pda(&user));
    }
}
