use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::errors::GatewayError;
use crate::state::{SwapSnapshot, SNAPSHOT_SEED};

/// Snapshots `user_reward_token_account.amount` into a deterministic PDA so
/// the closing instruction can compute the swap delta. The PDA is keyed by
/// the token account's pubkey — unique per (user, mint) pair without an extra
/// nonce.
#[derive(Accounts)]
pub struct Open<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Blocks PDA squatting: only the token account's owner can open its snapshot.
    #[account(
        constraint = user_reward_token_account.owner == user.key()
            @ GatewayError::AtaOwnerMismatch,
    )]
    pub user_reward_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        space = SwapSnapshot::SPACE,
        seeds = [SNAPSHOT_SEED, user_reward_token_account.key().as_ref()],
        bump,
    )]
    pub snapshot: Account<'info, SwapSnapshot>,

    pub system_program: Program<'info, System>,
}

pub fn open(ctx: Context<Open>) -> Result<()> {
    let snapshot = &mut ctx.accounts.snapshot;
    snapshot.pre_balance = ctx.accounts.user_reward_token_account.amount;
    snapshot.bump = ctx.bumps.snapshot;
    Ok(())
}
