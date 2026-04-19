use anchor_lang::prelude::*;

use crate::events::RouteBufferCreated;
use crate::instructions::IntentPublisherError;
use crate::state::{RouteBuffer, MAX_ROUTE_LEN, ROUTE_BUFFER_SEED};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WriteRouteBufferArgs {
    pub route: Vec<u8>,
}

#[derive(Accounts)]
pub struct WriteRouteBuffer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + RouteBuffer::INIT_SPACE,
        seeds = [ROUTE_BUFFER_SEED, user.key().as_ref()],
        bump,
    )]
    pub route_buffer: Account<'info, RouteBuffer>,

    pub system_program: Program<'info, System>,
}

pub fn write_route_buffer(
    ctx: Context<WriteRouteBuffer>,
    args: WriteRouteBufferArgs,
) -> Result<()> {
    require!(
        args.route.len() <= MAX_ROUTE_LEN,
        IntentPublisherError::RouteTooLong
    );

    let route_buffer = &mut ctx.accounts.route_buffer;
    route_buffer.user = ctx.accounts.user.key();
    route_buffer.route_data = args.route;

    emit!(RouteBufferCreated::new(ctx.accounts.user.key()));

    Ok(())
}
