use anchor_lang::prelude::*;
use anchor_spl::associated_token::{
    self, get_associated_token_address_with_program_id, AssociatedToken, Create,
};
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};
use portal::state::vault_pda;
use portal::types::{intent_hash as compute_intent_hash, Reward};

use crate::errors::GatewayError;
use crate::events::{IntentFunded, IntentSelected};
use crate::instructions::shared::{validate_base_reward_common, validate_buckets_and_pick};
use crate::mint_safety::require_safe_mint;
use crate::state::{SwapSnapshot, SNAPSHOT_SEED};
use crate::types::CloseAndSelectArgs;

#[derive(Accounts)]
#[instruction(args: CloseAndSelectArgs)]
pub struct CloseAndSelectIntent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Source of reward tokens; `transfer_checked` authority for both the
    /// vault-fund transfer and the surplus sweep. The `owner == user`
    /// constraint re-verifies after any intermediate ixs (e.g. Jupiter) ran
    /// in the same tx.
    #[account(
        mut,
        constraint = user_reward_ata.owner == user.key()
            @ GatewayError::AtaOwnerMismatch,
        constraint = user_reward_ata.mint == mint.key()
            @ GatewayError::MintMismatch,
    )]
    pub user_reward_ata: InterfaceAccount<'info, TokenAccount>,

    /// Opened by `open`; seeded by `user_reward_ata`. Rent refunds to `user`.
    #[account(
        mut,
        close = user,
        seeds = [SNAPSHOT_SEED, user_reward_ata.key().as_ref()],
        bump = snapshot.bump,
    )]
    pub snapshot: Account<'info, SwapSnapshot>,

    /// Surplus (`delta - reward_amount_k`) recipient. Must share the reward mint.
    #[account(
        mut,
        constraint = sweep_recipient_ata.mint == mint.key()
            @ GatewayError::MintMismatch,
    )]
    pub sweep_recipient_ata: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // `remaining_accounts`: [vault_pda_0, vault_ata_0, ..., vault_pda_{N-1}, vault_ata_{N-1}].
}

pub fn close_and_select_intent<'info>(
    ctx: Context<'_, '_, '_, 'info, CloseAndSelectIntent<'info>>,
    args: CloseAndSelectArgs,
) -> Result<()> {
    let CloseAndSelectArgs {
        destination,
        base_reward,
        buckets,
        buckets_hash,
    } = args;

    // --- Base-reward invariants (SPL shape) ---
    validate_base_reward(&base_reward, &ctx.accounts.mint.key())?;

    let now = Clock::get()?.unix_timestamp.max(0) as u64;
    require!(base_reward.deadline > now, GatewayError::DeadlineExpired);

    // Mint extension allowlist (SPL Token is unconditionally accepted).
    require_safe_mint(&ctx.accounts.mint.to_account_info())?;

    // --- Delta measurement ---
    let delta = ctx
        .accounts
        .user_reward_ata
        .amount
        .checked_sub(ctx.accounts.snapshot.pre_balance)
        .ok_or(GatewayError::ZeroDelta)?;

    // --- Bucket validation + floor selection (shared with the native ix) ---
    let (k, reward_amount_k, route_hash_k, computed_hash) =
        validate_buckets_and_pick(&buckets, buckets_hash, delta)?;

    // --- Remaining-accounts layout: [vault_pda_k, vault_ata_k] pairs ---
    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() == 2 * buckets.len(),
        GatewayError::InvalidRemainingAccounts
    );
    let vault_pda_k = &remaining[2 * k];
    let vault_ata_k = &remaining[2 * k + 1];

    // --- Clone reward template, set bucket amount, compute intent_hash ---
    let mut reward_k = base_reward;
    reward_k.tokens[0].amount = reward_amount_k;
    let intent_hash = compute_intent_hash(destination, &route_hash_k, &reward_k.hash());
    let (expected_vault_pda, _) = vault_pda(&intent_hash);
    require!(
        vault_pda_k.key() == expected_vault_pda,
        GatewayError::InvalidVaultAccount
    );

    // --- Fund the vault ATA directly (no Portal CPI) ---
    //
    // We replicate portal.fund's token path — canonical-ATA check,
    // create_idempotent, transfer_checked — but skip its native-lamport path
    // (base_reward.native_amount is required to be 0) and its `IntentFunded`
    // emission (we emit our own below). Skipping the CPI means this
    // instruction no longer puts `portal` on the invocation stack, which is
    // what lets it run nested inside `portal.fulfill` (e.g. as a Route call
    // in a `flash_fulfill` execution).
    let mint_ai = ctx.accounts.mint.to_account_info();
    let token_program_ai = pick_token_program(
        &mint_ai,
        &ctx.accounts.token_program,
        &ctx.accounts.token_2022_program,
    );
    let token_program_id = *token_program_ai.key;

    let expected_vault_ata = get_associated_token_address_with_program_id(
        &vault_pda_k.key(),
        &mint_ai.key(),
        &token_program_id,
    );
    require!(
        vault_ata_k.key() == expected_vault_ata,
        GatewayError::InvalidVaultAta
    );

    if vault_ata_k.data_is_empty() {
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.user.to_account_info(),
                associated_token: vault_ata_k.to_account_info(),
                authority: vault_pda_k.to_account_info(),
                mint: mint_ai.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: token_program_ai.clone(),
            },
        ))?;
    }

    transfer_checked(
        CpiContext::new(
            token_program_ai.clone(),
            TransferChecked {
                from: ctx.accounts.user_reward_ata.to_account_info(),
                to: vault_ata_k.to_account_info(),
                mint: mint_ai.clone(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        reward_amount_k,
        ctx.accounts.mint.decimals,
    )?;

    // --- Sweep surplus ---
    let surplus = delta - reward_amount_k;
    if surplus > 0 {
        transfer_checked(
            CpiContext::new(
                token_program_ai,
                TransferChecked {
                    from: ctx.accounts.user_reward_ata.to_account_info(),
                    to: ctx.accounts.sweep_recipient_ata.to_account_info(),
                    mint: mint_ai,
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            surplus,
            ctx.accounts.mint.decimals,
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
    // `complete: true` is always correct in this ix: the reward is a single
    // token (`validate_base_reward` enforces `tokens.len() == 1`),
    // `native_amount` is pinned to 0, and `transfer_checked` above either
    // moved the full `reward_amount_k` or reverted. If this ix ever grows
    // partial-funding semantics, compute `complete` from actual transfer
    // outcomes instead of hardcoding.
    emit!(IntentFunded::new(
        intent_hash,
        ctx.accounts.user.key(),
        true,
    ));

    Ok(())
}

fn validate_base_reward(reward: &Reward, mint_key: &Pubkey) -> Result<()> {
    validate_base_reward_common(reward)?;
    require!(
        reward.native_amount == 0,
        GatewayError::InvalidBaseRewardNative
    );
    require!(
        reward.tokens.len() == 1,
        GatewayError::InvalidBaseRewardTokens
    );
    require!(
        reward.tokens[0].token == *mint_key,
        GatewayError::MintMismatch
    );
    require!(
        reward.tokens[0].amount == 0,
        GatewayError::InvalidBaseRewardAmount
    );
    Ok(())
}

/// Pick the token program that owns `mint` — Token vs Token-2022.
///
/// The `else` branch returns Token-2022 unconditionally; this is safe only
/// because `require_safe_mint` runs earlier and guarantees the mint is owned
/// by exactly one of `{token::ID, token_2022::ID}`. If that gatekeeper moves
/// or is removed, tighten this to an explicit equality check + error.
fn pick_token_program<'info>(
    mint_ai: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    token_2022_program: &Program<'info, Token2022>,
) -> AccountInfo<'info> {
    if *mint_ai.owner == anchor_spl::token::ID {
        token_program.to_account_info()
    } else {
        token_2022_program.to_account_info()
    }
}
