use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, spl_token, CloseAccount, Token};
use anchor_spl::token_interface::TokenAccount;
use portal::state::vault_pda;
use portal::types::{intent_hash as compute_intent_hash, Reward};

use crate::errors::GatewayError;
use crate::events::{IntentFunded, IntentSelected};
use crate::instructions::shared::{validate_base_reward_common, validate_buckets_and_pick};
use crate::state::{SwapSnapshot, SNAPSHOT_SEED};
use crate::types::CloseAndSelectArgs;

/// Bucketed close-and-select for **native-SOL rewards**. The LOCAL intent's
/// reward is `nativeAmount > 0, tokens = []`; the corresponding source-chain
/// vault holds raw lamports (no SPL ATA). The swap output that flows in
/// during the open→close window is wSOL, which we convert to native lamports
/// via `close_account` and forward to the vault PDA.
///
/// Mirrors `close_and_select_intent` (SPL flow) at the high level but with:
///   - `user_reward_account` is the user's wSOL ATA (mint = `NATIVE_MINT`).
///   - Funding via `system::transfer` to `vault_pda_k`, not SPL `transfer_checked`
///     to a vault ATA.
///   - Surplus sweep via `system::transfer` to a `SystemAccount`.
///   - Remaining accounts are `[vault_pda_0, ..., vault_pda_{N-1}]` (N entries,
///     no vault ATA — native vault has no associated SPL account).
///
/// As with the SPL flow, no Portal CPI runs — letting this ix nest inside
/// `Portal::fulfill::execute_route_call` without reentering Portal.
#[derive(Accounts)]
#[instruction(args: CloseAndSelectArgs)]
pub struct CloseAndSelectIntentNative<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// User's wSOL ATA (Jupiter's swap output for SOL-out routes). Mint must
    /// be the canonical native mint; owner must be `user`. Re-checked here
    /// to defend against intermediate-ix tampering between `open` and the
    /// close.
    #[account(
        mut,
        constraint = user_wsol_ata.owner == user.key()
            @ GatewayError::AtaOwnerMismatch,
        constraint = user_wsol_ata.mint == spl_token::native_mint::ID
            @ GatewayError::MintMismatch,
    )]
    pub user_wsol_ata: InterfaceAccount<'info, TokenAccount>,

    /// Opened by `open`; seeded by `user_wsol_ata`. Rent refunds to `user`.
    #[account(
        mut,
        close = user,
        seeds = [SNAPSHOT_SEED, user_wsol_ata.key().as_ref()],
        bump = snapshot.bump,
    )]
    pub snapshot: Account<'info, SwapSnapshot>,

    /// Receives `delta - reward_amount_k` lamports of native SOL. The
    /// `SystemAccount` constraint rejects program-owned destinations
    /// (a Token ATA, a vault PDA, etc.) — only ordinary system-owned
    /// accounts can sit here.
    #[account(mut)]
    pub sweep_lamport_recipient: SystemAccount<'info>,

    /// SPL Token program — used for the `close_account` CPI that converts
    /// wSOL into native lamports on `user`.
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [vault_pda_0, vault_pda_1, ..., vault_pda_{N-1}]
}

pub fn close_and_select_intent_native<'info>(
    ctx: Context<'_, '_, '_, 'info, CloseAndSelectIntentNative<'info>>,
    args: CloseAndSelectArgs,
) -> Result<()> {
    let CloseAndSelectArgs {
        destination,
        base_reward,
        buckets,
        buckets_hash,
    } = args;

    // --- Base-reward invariants (native shape) ---
    validate_base_reward_native(&base_reward)?;

    let now = Clock::get()?.unix_timestamp.max(0) as u64;
    require!(base_reward.deadline > now, GatewayError::DeadlineExpired);

    // --- Delta measurement (wSOL ATA balance change) ---
    // wSOL has 1:1 lamport↔amount semantics, so `delta` is both the SPL token
    // amount and the lamport count we'll be moving onward.
    let delta = ctx
        .accounts
        .user_wsol_ata
        .amount
        .checked_sub(ctx.accounts.snapshot.pre_balance)
        .ok_or(GatewayError::ZeroDelta)?;

    // --- Bucket validation + floor selection (shared with the SPL ix) ---
    let (k, reward_amount_k, route_hash_k, computed_hash) =
        validate_buckets_and_pick(&buckets, buckets_hash, delta)?;

    // --- Remaining-accounts layout: bare vault_pda_k (no ATA for native) ---
    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() == buckets.len(),
        GatewayError::InvalidRemainingAccounts
    );
    let vault_pda_k = &remaining[k];

    // --- Clone reward template, fill the native_amount slot, compute intent_hash ---
    let mut reward_k = base_reward;
    reward_k.native_amount = reward_amount_k;
    let intent_hash = compute_intent_hash(destination, &route_hash_k, &reward_k.hash());
    let (expected_vault_pda, _) = vault_pda(&intent_hash);
    require!(
        vault_pda_k.key() == expected_vault_pda,
        GatewayError::InvalidVaultAccount
    );

    // --- Convert wSOL → native lamports on `user` via close_account ---
    //
    // wSOL ATAs hold `rent + amount` lamports; closing returns ALL of them to
    // `dest`. Authority is `user` — the same Signer slot at the outer ix
    // level, which the Portal::fulfill `execute_route_call` rule
    // (`is_signer || key == *executor`) propagates to inner ixs when this
    // ix runs nested under `flash_fulfill`.
    //
    // After this CPI: user_wsol_ata is gone, `user.lamports() += rent + delta`.
    token::close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.user_wsol_ata.to_account_info(),
            destination: ctx.accounts.user.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    ))?;

    // --- Fund the bucket's vault PDA with `reward_amount_k` lamports ---
    //
    // `vault_pda_k` is system-owned with zero data (Portal never `assign`s it),
    // so `system::transfer` lands cleanly. Portal::withdraw_native later does
    // `min(reward.native_amount, vault.lamports())` so this is the canonical
    // funding path.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: vault_pda_k.clone(),
            },
        ),
        reward_amount_k,
    )?;

    // --- Sweep surplus ---
    // `delta - reward_amount_k` lamports go to sweep_lamport_recipient.
    // The wSOL ATA's recovered rent (~0.00204 SOL) stays on `user` —
    // it's infrastructure cost the operator paid, not swap surplus.
    let surplus = delta - reward_amount_k;
    if surplus > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.sweep_lamport_recipient.to_account_info(),
                },
            ),
            surplus,
        )?;
    }

    // --- Events ---
    emit!(IntentSelected::new(
        intent_hash,
        ctx.accounts.user.key(),
        delta,
        k as u64,
        reward_amount_k,
        computed_hash,
    ));
    // `complete: true` mirrors the SPL flow's invariant: bucket selection
    // funds exactly `reward_amount_k`, and `system::transfer` either
    // succeeds in full or reverts.
    emit!(IntentFunded::new(
        intent_hash,
        ctx.accounts.user.key(),
        true,
    ));

    Ok(())
}

fn validate_base_reward_native(reward: &Reward) -> Result<()> {
    validate_base_reward_common(reward)?;
    require!(
        reward.tokens.is_empty(),
        GatewayError::InvalidBaseRewardNativeTokens
    );
    require!(
        reward.native_amount == 0,
        GatewayError::InvalidBaseRewardNative
    );
    Ok(())
}
