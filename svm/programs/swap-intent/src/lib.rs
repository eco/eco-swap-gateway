use anchor_lang::prelude::*;

declare_id!("SwapWDrRP31o8gbK5cpHmKyFC4BjHEkZB5ZqbHq4VUH");

pub mod constants;
pub mod cpi;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

#[program]
pub mod swap_intent {
    use super::*;

    pub fn write_route_buffer(
        ctx: Context<WriteRouteBuffer>,
        args: WriteRouteBufferArgs,
    ) -> Result<()> {
        instructions::write_route_buffer(ctx, args)
    }

    pub fn open(ctx: Context<Open>) -> Result<()> {
        open_swap(ctx)
    }

    pub fn close_and_create_intent<'info>(
        ctx: Context<'_, '_, '_, 'info, CloseAndCreateIntent<'info>>,
        args: CreateIntentArgs,
    ) -> Result<()> {
        close_and_create(ctx, args)
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        cancel_swap(ctx)
    }
}
