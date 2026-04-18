use anchor_lang::prelude::*;

use crate::instructions::IntentPublisherError;
use crate::state::{RouteBuffer, ROUTE_BUFFER_SEED};

#[derive(Accounts)]
pub struct CloseRouteBuffer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [ROUTE_BUFFER_SEED, user.key().as_ref()],
        bump,
        constraint = route_buffer.user == user.key() @ IntentPublisherError::InvalidUser,
    )]
    pub route_buffer: Account<'info, RouteBuffer>,
}

pub fn close_route_buffer(_ctx: Context<CloseRouteBuffer>) -> Result<()> {
    Ok(())
}
