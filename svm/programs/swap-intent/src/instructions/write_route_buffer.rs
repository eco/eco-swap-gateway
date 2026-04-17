use anchor_lang::prelude::*;

use crate::state::{RouteBuffer, ROUTE_BUFFER_SEED};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WriteRouteBufferArgs {
    /// ABI-encoded route template with placeholder amounts.
    pub route_template: Vec<u8>,

    /// Byte offset of `tokens[0].amount` in `route_template` (always patched).
    pub tokens_amount_offset: u32,

    /// Byte offset of transfer amount in `calls[0].data`.
    /// Set to `u32::MAX` to skip patching (Case 3: DEX swap routes).
    pub calldata_amount_offset: u32,
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
    let route_buffer = &mut ctx.accounts.route_buffer;
    route_buffer.user = ctx.accounts.user.key();
    route_buffer.tokens_amount_offset = args.tokens_amount_offset;
    route_buffer.calldata_amount_offset = args.calldata_amount_offset;
    route_buffer.route_data = args.route_template;

    Ok(())
}
