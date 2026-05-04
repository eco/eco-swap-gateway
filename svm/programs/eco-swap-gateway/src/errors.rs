use anchor_lang::prelude::*;

#[error_code]
pub enum GatewayError {
    #[msg("Swap delta is zero (output token balance did not increase).")]
    ZeroDelta,
    #[msg("Swap delta is below the lowest bucket's reward amount.")]
    DeltaBelowFloor,
    #[msg("Buckets must be strictly ascending by reward_amount.")]
    BucketsNotAscending,
    #[msg("Buckets list is empty or exceeds the N <= 14 cap.")]
    InvalidBucketCount,
    #[msg("Reward token mint does not match the provided mint account.")]
    MintMismatch,
    #[msg("User reward token account owner does not match the user signer.")]
    AtaOwnerMismatch,
    #[msg("Reward must have exactly one token entry.")]
    InvalidBaseRewardTokens,
    #[msg("Reward tokens[0].amount must be zero in the template.")]
    InvalidBaseRewardAmount,
    #[msg("Reward native_amount must be zero for v1.")]
    InvalidBaseRewardNative,
    #[msg("Reward creator must not be the default pubkey.")]
    InvalidRewardCreator,
    #[msg("Reward prover must not be the default pubkey.")]
    InvalidRewardProver,
    #[msg("Reward deadline has already elapsed.")]
    DeadlineExpired,
    #[msg("Mint carries a Token-2022 extension that is not safe for this program.")]
    UnsafeMintExtension,
    #[msg("Provided buckets_hash does not match keccak(borsh(buckets)).")]
    BucketsHashMismatch,
    #[msg("The number of remaining accounts does not match 2 * buckets.len().")]
    InvalidRemainingAccounts,
    #[msg("vault_pda_k at the expected offset does not match the derived PDA.")]
    InvalidVaultAccount,
    #[msg("vault_ata_k at the expected offset does not match the derived ATA.")]
    InvalidVaultAta,
}
