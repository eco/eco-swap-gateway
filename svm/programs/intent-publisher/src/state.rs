use anchor_lang::prelude::*;

pub const ROUTE_BUFFER_SEED: &[u8] = b"route_buffer";

pub fn route_buffer_pda(user: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ROUTE_BUFFER_SEED, user.as_ref()], &crate::ID)
}

/// Pre-populated buffer storing an already-encoded route.
/// Created in a setup transaction for large routes that don't fit in instruction data.
/// Consumed and closed by `create_intent_from_buffer`.
///
/// Max route size is 1024 bytes. Typical ABI-encoded routes are ~608 bytes.
/// Solana tx limit is 1232 bytes, so routes above ~400 bytes (after accounting
/// for accounts, signatures, and other instruction data) need the buffer path.
#[account]
#[derive(InitSpace)]
pub struct RouteBuffer {
    pub user: Pubkey,
    #[max_len(1024)]
    pub route_data: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_buffer_pda_deterministic() {
        let user = Pubkey::new_from_array([42u8; 32]);
        goldie::assert_json!(route_buffer_pda(&user));
    }
}
