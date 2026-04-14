use anchor_lang::prelude::*;

use crate::events::SwapCancelled;
use crate::instructions::SwapIntentError;
use crate::state::{SwapState, SWAP_STATE_SEED};

#[derive(Accounts)]
pub struct Cancel<'info> {
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
}

pub fn cancel_swap(ctx: Context<Cancel>) -> Result<()> {
    emit!(SwapCancelled::new(ctx.accounts.user.key()));
    Ok(())
}
