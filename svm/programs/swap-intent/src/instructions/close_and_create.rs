use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use anchor_spl::{associated_token, token, token_2022};
use eco_svm_std::Bytes32;
use tiny_keccak::{Hasher, Keccak};

use crate::constants::SKIP_CALLDATA_PATCH;
use crate::cpi;
use crate::events::IntentCreated;
use crate::instructions::SwapIntentError;
use crate::state::{SwapState, SWAP_STATE_SEED};

/// An optional EVM call included in the route template for transparency.
/// Already embedded in `route_template`; not used in on-chain computation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EvmCall {
    pub target: [u8; 32],
    pub data: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateIntentArgs {
    /// Destination chain ID.
    pub destination: u64,

    /// ABI-encoded route template with placeholder amounts.
    pub route_template: Vec<u8>,

    /// Byte offset of `tokens[0].amount` in `route_template` (always patched).
    pub tokens_amount_offset: u32,

    /// Byte offset of transfer amount in `calls[0].data`.
    /// Set to `u32::MAX` to skip patching (Case 3: DEX swap routes).
    pub calldata_amount_offset: u32,

    /// Reward deadline on the source chain.
    pub reward_deadline: u64,

    /// Creator of the intent (receives refund if intent expires).
    pub reward_creator: Pubkey,

    /// Prover program that can prove fulfillment.
    pub reward_prover: Pubkey,

    /// SPL mint of the reward token (must match the swap output token).
    pub reward_token: Pubkey,

    /// Reward amount locked for the solver. 0 = use full swap_output.
    pub reward_amount: u64,

    /// Fixed fee subtracted after scaling (in output token units, post-scalar).
    pub flat_fee: u64,

    /// Scalar numerator for proportional fee (applied first). Must be > 0.
    pub scalar_num: u64,

    /// Scalar denominator for proportional fee.
    pub scalar_denom: u64,

    /// Decimals of the source (swap output) token on this chain.
    pub source_decimals: u8,

    /// Decimals of the destination token on the target chain.
    pub destination_decimals: u8,

    /// Whether to allow partial vault funding.
    pub allow_partial: bool,

    /// Optional extra calls embedded in the route template (for off-chain transparency only).
    /// Not used in on-chain computation — deserialized and discarded. Each entry adds to
    /// instruction data size and deserialization compute cost. Keep minimal.
    pub extra_calls: Vec<EvmCall>,
}

#[derive(Accounts)]
pub struct CloseAndCreateIntent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [SWAP_STATE_SEED, user.key().as_ref()],
        bump = swap_state.bump,
        constraint = swap_state.user == user.key() @ SwapIntentError::InvalidUser,
    )]
    pub swap_state: Account<'info, SwapState>,

    #[account(
        constraint = output_token_account.key() == swap_state.output_token_account @ SwapIntentError::InvalidTokenAccount,
        constraint = output_token_account.mint == swap_state.output_mint @ SwapIntentError::InvalidMint,
    )]
    pub output_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: validated against portal::ID.
    #[account(
        executable,
        address = portal::ID @ SwapIntentError::InvalidPortalProgram,
    )]
    pub portal_program: UncheckedAccount<'info>,

    /// CHECK: validated against vault_pda derivation in handler logic.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    pub token_program: Program<'info, token::Token>,
    pub token_2022_program: Program<'info, token_2022::Token2022>,
    pub associated_token_program: Program<'info, associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [from_ata, vault_ata, mint] per reward token for Portal::fund
}

pub fn close_and_create<'info>(
    ctx: Context<'_, '_, '_, 'info, CloseAndCreateIntent<'info>>,
    args: CreateIntentArgs,
) -> Result<()> {
    let CreateIntentArgs {
        destination,
        mut route_template,
        tokens_amount_offset,
        calldata_amount_offset,
        reward_deadline,
        reward_creator,
        reward_prover,
        reward_token,
        reward_amount,
        flat_fee,
        scalar_num,
        scalar_denom,
        source_decimals,
        destination_decimals,
        allow_partial,
        extra_calls: _, // Already embedded in route_template
    } = args;

    // 1. Validate scalar parameters
    require!(scalar_denom > 0, SwapIntentError::InvalidScalar);
    require!(scalar_num > 0, SwapIntentError::InvalidScalar);
    require!(scalar_num <= scalar_denom, SwapIntentError::InvalidScalar);

    // 2. Validate reward_token matches the swap output mint
    require!(
        reward_token == ctx.accounts.swap_state.output_mint,
        SwapIntentError::InvalidMint
    );

    // 3. Validate remaining_accounts length (must be multiple of 3: from_ata, vault_ata, mint)
    require!(
        ctx.remaining_accounts.len() % 3 == 0,
        SwapIntentError::InvalidRemainingAccounts
    );

    // 4. Calculate swap output (balance delta)
    let post_balance = ctx.accounts.output_token_account.amount;
    let swap_output = post_balance
        .checked_sub(ctx.accounts.swap_state.pre_balance)
        .ok_or(SwapIntentError::ArithmeticOverflow)?;
    require!(swap_output > 0, SwapIntentError::InsufficientSwapOutput);

    // 5. Resolve reward amount: 0 means use full swap_output.
    let actual_reward = if reward_amount == 0 { swap_output } else { reward_amount };
    require!(
        actual_reward <= swap_output,
        SwapIntentError::RewardExceedsSwapOutput
    );

    // 6. Calculate fee-adjusted amount in source decimals.
    //    Uses u128 intermediate to avoid overflow on large swap_output * scalar_num.
    //    Integer division truncates toward zero (floor), which is standard for on-chain fee math.
    let scaled = (swap_output as u128)
        .checked_mul(scalar_num as u128)
        .and_then(|v| v.checked_div(scalar_denom as u128))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(SwapIntentError::ArithmeticOverflow)?;
    let net_amount = scaled
        .checked_sub(flat_fee)
        .ok_or(SwapIntentError::ArithmeticOverflow)?;
    require!(net_amount > 0, SwapIntentError::RouteAmountZero);

    // 7. Convert from source decimals to destination decimals.
    //    Scaling UP (dest > source) can overflow u64, so route_amount is u128.
    //    Scaling DOWN (source > dest) truncates via integer division (may produce 0).
    let route_amount: u128 = if source_decimals > destination_decimals {
        let divisor = 10u128
            .checked_pow((source_decimals - destination_decimals) as u32)
            .ok_or(SwapIntentError::ArithmeticOverflow)?;
        (net_amount as u128) / divisor
    } else if destination_decimals > source_decimals {
        let multiplier = 10u128
            .checked_pow((destination_decimals - source_decimals) as u32)
            .ok_or(SwapIntentError::ArithmeticOverflow)?;
        (net_amount as u128)
            .checked_mul(multiplier)
            .ok_or(SwapIntentError::ArithmeticOverflow)?
    } else {
        net_amount as u128
    };
    require!(route_amount > 0, SwapIntentError::RouteAmountZero);

    // 8. Patch route_template at tokens_amount_offset (always)
    let amount_bytes = to_be_uint256(route_amount);
    patch_route_template(
        &mut route_template,
        tokens_amount_offset as usize,
        &amount_bytes,
    )?;

    // 9. Patch route_template at calldata_amount_offset (skip if sentinel u32::MAX)
    if calldata_amount_offset != SKIP_CALLDATA_PATCH {
        patch_route_template(
            &mut route_template,
            calldata_amount_offset as usize,
            &amount_bytes,
        )?;
    }

    // 10. Compute route_hash = keccak256(patched_route)
    let route_hash = keccak256(&route_template);

    // 11. Build Reward and compute hashes.
    //    reward.tokens[0].amount = actual_reward (may be less than swap_output).
    //    The solver fronts route_amount on the destination chain and claims actual_reward as profit.
    let reward = portal::types::Reward {
        deadline: reward_deadline,
        creator: reward_creator,
        prover: reward_prover,
        native_amount: 0,
        tokens: vec![portal::types::TokenAmount {
            token: reward_token,
            amount: actual_reward,
        }],
    };
    let reward_hash = reward.hash();
    let intent_hash = portal::types::intent_hash(destination, &route_hash, &reward_hash);

    // 12. Validate vault PDA
    let (expected_vault, _) = portal::state::vault_pda(&intent_hash);
    require!(
        ctx.accounts.vault.key() == expected_vault,
        SwapIntentError::InvalidVault
    );

    // 13. CPI Portal::publish
    let publish_args = portal::instructions::PublishArgs {
        destination,
        route: route_template,
        reward: reward.clone(),
    };
    cpi::publish::publish(&ctx.accounts.portal_program, publish_args)?;

    // 14. CPI Portal::fund
    let fund_args = portal::instructions::FundArgs {
        destination,
        route_hash,
        reward,
        allow_partial,
    };
    cpi::fund::fund(
        &ctx.accounts.portal_program,
        &ctx.accounts.user.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.remaining_accounts,
        fund_args,
    )?;

    // 15. Emit event (swap_state close happens via Anchor constraint)
    emit!(IntentCreated::new(
        intent_hash,
        ctx.accounts.user.key(),
        reward_token,
        swap_output,
        actual_reward,
        route_amount,
        destination,
    ));

    Ok(())
}

/// Convert a u128 to a big-endian uint256 (32 bytes, zero-left-padded).
fn to_be_uint256(value: u128) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[16..32].copy_from_slice(&value.to_be_bytes());
    bytes
}

/// Patch 32 bytes of a route template at the given offset.
fn patch_route_template(route: &mut [u8], offset: usize, value: &[u8; 32]) -> Result<()> {
    let end = offset
        .checked_add(32)
        .filter(|&end| end <= route.len())
        .ok_or(SwapIntentError::OffsetOutOfBounds)?;
    route[offset..end].copy_from_slice(value);
    Ok(())
}

fn keccak256(data: &[u8]) -> Bytes32 {
    let mut hasher = Keccak::v256();
    let mut hash = [0u8; 32];
    hasher.update(data);
    hasher.finalize(&mut hash);
    hash.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_be_uint256_zero() {
        let result = to_be_uint256(0);
        assert_eq!(result, [0u8; 32]);
    }

    #[test]
    fn to_be_uint256_one() {
        let mut expected = [0u8; 32];
        expected[31] = 1;
        assert_eq!(to_be_uint256(1), expected);
    }

    #[test]
    fn to_be_uint256_u64_max() {
        let result = to_be_uint256(u64::MAX as u128);
        assert_eq!(&result[..16], &[0u8; 16]);
        assert_eq!(&result[16..], &(u64::MAX as u128).to_be_bytes());
    }

    #[test]
    fn to_be_uint256_u128_max() {
        let result = to_be_uint256(u128::MAX);
        assert_eq!(&result[16..], &u128::MAX.to_be_bytes());
    }

    #[test]
    fn to_be_uint256_large_decimal_conversion() {
        // Simulates 6→18 decimal conversion: 18_400 USDC (6 dec) * 10^12
        let value: u128 = 18_400_000_000 * 1_000_000_000_000;
        let result = to_be_uint256(value);
        assert_eq!(&result[..16], &[0u8; 16]);
        assert_eq!(&result[16..], &value.to_be_bytes());
    }

    #[test]
    fn patch_route_template_valid() {
        let mut route = vec![0u8; 64];
        let value = [0xABu8; 32];
        patch_route_template(&mut route, 16, &value).unwrap();
        assert_eq!(&route[16..48], &[0xAB; 32]);
        assert_eq!(&route[0..16], &[0; 16]);
        assert_eq!(&route[48..64], &[0; 16]);
    }

    #[test]
    fn patch_route_template_at_end() {
        let mut route = vec![0u8; 32];
        let value = [0xFFu8; 32];
        patch_route_template(&mut route, 0, &value).unwrap();
        assert_eq!(&route, &[0xFF; 32]);
    }

    #[test]
    fn patch_route_template_out_of_bounds() {
        let mut route = vec![0u8; 31];
        let value = [0u8; 32];
        let result = patch_route_template(&mut route, 0, &value);
        assert!(result.is_err());
    }

    #[test]
    fn patch_route_template_offset_overflow() {
        let mut route = vec![0u8; 64];
        let value = [0u8; 32];
        let result = patch_route_template(&mut route, usize::MAX, &value);
        assert!(result.is_err());
    }

    #[test]
    fn keccak256_deterministic() {
        let data = b"hello world";
        let hash1 = keccak256(data);
        let hash2 = keccak256(data);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn keccak256_different_inputs() {
        let hash1 = keccak256(b"hello");
        let hash2 = keccak256(b"world");
        assert_ne!(hash1, hash2);
    }
}
