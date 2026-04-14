use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::state::{SwapState, SWAP_STATE_SEED};

#[derive(Accounts)]
pub struct Open<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = output_token_account.owner == user.key(),
    )]
    pub output_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        space = 8 + SwapState::INIT_SPACE,
        seeds = [SWAP_STATE_SEED, user.key().as_ref()],
        bump,
    )]
    pub swap_state: Account<'info, SwapState>,

    pub system_program: Program<'info, System>,
}

pub fn open_swap(ctx: Context<Open>) -> Result<()> {
    let swap_state = &mut ctx.accounts.swap_state;
    swap_state.user = ctx.accounts.user.key();
    swap_state.output_token_account = ctx.accounts.output_token_account.key();
    swap_state.output_mint = ctx.accounts.output_token_account.mint;
    swap_state.pre_balance = ctx.accounts.output_token_account.amount;
    swap_state.bump = ctx.bumps.swap_state;

    Ok(())
}
