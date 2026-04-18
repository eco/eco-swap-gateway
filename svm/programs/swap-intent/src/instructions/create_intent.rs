use anchor_lang::prelude::*;
use anchor_spl::{associated_token, token, token_2022};
use eco_svm_std::Bytes32;
use tiny_keccak::{Hasher, Keccak};

use crate::cpi;
use crate::events::IntentCreated;
use crate::instructions::SwapIntentError;
use crate::state::{RouteBuffer, ROUTE_BUFFER_SEED};

// ── Args ──────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateIntentArgs {
    pub destination: u64,
    pub route: Vec<u8>,
    pub reward: portal::types::Reward,
    pub allow_partial: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateIntentFromBufferArgs {
    pub destination: u64,
    pub reward: portal::types::Reward,
    pub allow_partial: bool,
}

// ── Accounts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateIntent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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
    // remaining_accounts: [from_ata, vault_ata, mint] per reward token
}

#[derive(Accounts)]
pub struct CreateIntentFromBuffer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [ROUTE_BUFFER_SEED, user.key().as_ref()],
        bump,
        constraint = route_buffer.user == user.key() @ SwapIntentError::InvalidUser,
    )]
    pub route_buffer: Account<'info, RouteBuffer>,

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
    // remaining_accounts: [from_ata, vault_ata, mint] per reward token
}

// ── Handlers ──────────────────────────────────────────────────────────

pub fn create_intent<'info>(
    ctx: Context<'_, '_, '_, 'info, CreateIntent<'info>>,
    args: CreateIntentArgs,
) -> Result<()> {
    let a = &ctx.accounts;
    publish_and_fund(
        args.route,
        args.destination,
        args.reward,
        args.allow_partial,
        a.portal_program.as_ref(),
        &a.user,
        a.vault.as_ref(),
        a.token_program.as_ref(),
        a.token_2022_program.as_ref(),
        a.associated_token_program.as_ref(),
        a.system_program.as_ref(),
        ctx.remaining_accounts,
    )
}

pub fn create_intent_from_buffer<'info>(
    ctx: Context<'_, '_, '_, 'info, CreateIntentFromBuffer<'info>>,
    args: CreateIntentFromBufferArgs,
) -> Result<()> {
    let route = ctx.accounts.route_buffer.route_data.clone();
    let a = &ctx.accounts;
    publish_and_fund(
        route,
        args.destination,
        args.reward,
        args.allow_partial,
        a.portal_program.as_ref(),
        &a.user,
        a.vault.as_ref(),
        a.token_program.as_ref(),
        a.token_2022_program.as_ref(),
        a.associated_token_program.as_ref(),
        a.system_program.as_ref(),
        ctx.remaining_accounts,
    )
}

// ── Shared logic ──────────────────────────────────────────────────────

fn publish_and_fund<'info>(
    route: Vec<u8>,
    destination: u64,
    reward: portal::types::Reward,
    allow_partial: bool,
    portal_program: &AccountInfo<'info>,
    user: &Signer<'info>,
    vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    require!(
        remaining_accounts.len() % 3 == 0,
        SwapIntentError::InvalidRemainingAccounts
    );

    let route_hash = keccak256(&route);
    let reward_hash = reward.hash();
    let intent_hash = portal::types::intent_hash(destination, &route_hash, &reward_hash);

    let (expected_vault, _) = portal::state::vault_pda(&intent_hash);
    require!(
        vault.key() == expected_vault,
        SwapIntentError::InvalidVault
    );

    cpi::publish::publish(
        portal_program,
        portal::instructions::PublishArgs {
            destination,
            route,
            reward: reward.clone(),
        },
    )?;

    cpi::fund::fund(
        portal_program,
        &user.to_account_info(),
        &user.to_account_info(),
        vault,
        token_program,
        token_2022_program,
        associated_token_program,
        system_program,
        remaining_accounts,
        portal::instructions::FundArgs {
            destination,
            route_hash,
            reward,
            allow_partial,
        },
    )?;

    emit!(IntentCreated::new(intent_hash, user.key(), destination));

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
    fn keccak256_deterministic() {
        let data = b"hello world";
        assert_eq!(keccak256(data), keccak256(data));
    }

    #[test]
    fn keccak256_different_inputs() {
        assert_ne!(keccak256(b"hello"), keccak256(b"world"));
    }

    #[test]
    fn keccak256_known_vector() {
        let hash: Bytes32 = keccak256(b"");
        let expected: [u8; 32] = [
            0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c, 0x92, 0x7e, 0x7d, 0xb2, 0xdc, 0xc7,
            0x03, 0xc0, 0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b, 0x7b, 0xfa, 0xd8, 0x04,
            0x5d, 0x85, 0xa4, 0x70,
        ];
        assert_eq!(<[u8; 32]>::from(hash), expected);
    }
}
