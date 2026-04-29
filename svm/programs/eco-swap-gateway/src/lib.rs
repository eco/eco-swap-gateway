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

    /// Native-reward variant of `close_and_select_intent`. The LOCAL intent's
    /// reward is `nativeAmount > 0, tokens = []`; bucket amounts are
    /// interpreted as lamports. Converts the user's wSOL ATA into native
    /// lamports via `close_account` and forwards the bucket's reward to
    /// the vault PDA via `system::transfer`. Surplus lamports go to a
    /// system-owned `sweep_lamport_recipient`. Same no-Portal-CPI guarantee.
    pub fn close_and_select_intent_native<'info>(
        ctx: Context<'_, '_, '_, 'info, CloseAndSelectIntentNative<'info>>,
        args: CloseAndSelectArgs,
    ) -> Result<()> {
        instructions::close_and_select_intent_native(ctx, args)
    }
}
