use anchor_lang::prelude::*;

declare_id!("EcoS9WNe7onaxkS9STYMHhUKsvjQGte1eitKhXCpvSPi");

pub mod errors;
pub mod events;
pub mod instructions;
pub mod mint_safety;
pub mod state;
pub mod types;

use instructions::*;

#[program]
pub mod eco_swap_gateway {
    use super::*;

    /// Snapshot the user's reward-mint ATA balance into a short-lived PDA so
    /// `close_and_select_intent` can compute the swap delta.
    pub fn open(ctx: Context<Open>) -> Result<()> {
        instructions::open(ctx)
    }

    /// Measure delta vs. snapshot, floor-select a bucket, transfer the
    /// bucket's reward directly into the intent's canonical vault ATA
    /// (creating it idempotently), sweep any surplus to
    /// `sweep_recipient_ata`, then close the snapshot PDA. Emits
    /// `IntentSelected` + `IntentFunded`. No Portal CPI — lets this ix
    /// run nested under `portal::fulfill` without tripping reentrancy.
    pub fn close_and_select_intent<'info>(
        ctx: Context<'_, '_, '_, 'info, CloseAndSelectIntent<'info>>,
        args: CloseAndSelectArgs,
    ) -> Result<()> {
        instructions::close_and_select_intent(ctx, args)
    }
}
