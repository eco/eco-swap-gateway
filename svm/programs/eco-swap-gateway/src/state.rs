use anchor_lang::prelude::*;

pub const SNAPSHOT_SEED: &[u8] = b"snap";

/// Per-user, per-reward-mint snapshot of ATA balance at `open` time.
///
/// Seeded by `user_reward_ata` — unique per (user, mint) pair without needing
/// a separate nonce. The snapshot is consumed and closed by
/// `close_and_select_intent`, with the rent refunded to the user.
#[account]
#[derive(InitSpace, Debug, PartialEq)]
pub struct SwapSnapshot {
    pub pre_balance: u64,
    pub bump: u8,
}

impl SwapSnapshot {
    /// Rent-exemption size: 8-byte Anchor discriminator + `InitSpace`.
    pub const SPACE: usize = 8 + Self::INIT_SPACE;

    pub fn pda(user_reward_ata: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[SNAPSHOT_SEED, user_reward_ata.as_ref()], &crate::ID)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_pda_deterministic() {
        let ata = Pubkey::new_from_array([42u8; 32]);
        goldie::assert_json!(SwapSnapshot::pda(&ata));
    }
}
