use anchor_lang::prelude::*;

declare_id!("Ecof7tm19p8THsL3oQLWrUfji7Um47CemibkNSBjxJd3");

pub mod constants;
pub mod cpi;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

#[program]
pub mod intent_publisher {
    use super::*;

    pub fn write_route_buffer(
        ctx: Context<WriteRouteBuffer>,
        args: WriteRouteBufferArgs,
    ) -> Result<()> {
        instructions::write_route_buffer(ctx, args)
    }

    pub fn create_intent<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateIntent<'info>>,
        args: CreateIntentArgs,
    ) -> Result<()> {
        instructions::create_intent(ctx, args)
    }

    pub fn create_intent_from_buffer<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateIntentFromBuffer<'info>>,
        args: CreateIntentFromBufferArgs,
    ) -> Result<()> {
        instructions::create_intent_from_buffer(ctx, args)
    }

    pub fn close_route_buffer(ctx: Context<CloseRouteBuffer>) -> Result<()> {
        instructions::close_route_buffer(ctx)
    }
}
