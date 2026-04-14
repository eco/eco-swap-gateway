/// Anchor discriminator for Portal's `publish` instruction.
/// Computed as SHA256("global:publish")[..8].
pub const PUBLISH_DISCRIMINATOR: [u8; 8] = [129, 177, 182, 160, 184, 224, 219, 5];

/// Anchor discriminator for Portal's `fund` instruction.
/// Computed as SHA256("global:fund")[..8].
pub const FUND_DISCRIMINATOR: [u8; 8] = [218, 188, 111, 221, 152, 113, 174, 7];

/// Sentinel value indicating that the calldata offset should not be patched.
/// Used for Case 3 (DEX swap routes) where calldata is pre-encoded by the Solver.
pub const SKIP_CALLDATA_PATCH: u32 = u32::MAX;

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    #[test]
    fn publish_discriminator_matches_anchor_convention() {
        let expected = hash(b"global:publish").to_bytes();
        assert_eq!(PUBLISH_DISCRIMINATOR, expected[..8]);
    }

    #[test]
    fn fund_discriminator_matches_anchor_convention() {
        let expected = hash(b"global:fund").to_bytes();
        assert_eq!(FUND_DISCRIMINATOR, expected[..8]);
    }
}
