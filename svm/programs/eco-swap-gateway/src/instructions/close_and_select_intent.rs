use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};
use eco_svm_std::Bytes32;
use portal::instructions::FundArgs;
use portal::state::vault_pda;
use portal::types::{intent_hash as compute_intent_hash, Reward};
use tiny_keccak::{Hasher, Keccak};

use crate::errors::GatewayError;
use crate::events::IntentSelected;
use crate::mint_safety::require_safe_mint;
use crate::state::{SwapSnapshot, SNAPSHOT_SEED};
use crate::types::{Bucket, CloseAndSelectArgs, MAX_BUCKETS};

/// Anchor's global discriminator for `Portal::fund` — sha256("global:fund")[..8].
/// Pinned as a constant (not computed at runtime) so the CPI path runs in constant CU.
/// The unit test at the bottom of this file asserts it stays in sync with Anchor.
const FUND_DISCRIMINATOR: [u8; 8] = [218, 188, 111, 221, 152, 113, 174, 7];

#[derive(Accounts)]
#[instruction(args: CloseAndSelectArgs)]
pub struct CloseAndSelectIntent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Source of reward tokens; `transfer_checked` authority in Portal's CPI.
    /// The `owner == user` constraint re-verifies after any intermediate ixs
    /// (e.g. Jupiter) ran in the same tx.
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

    /// Portal program. CHECK: pinned by `address = portal::ID`.
    #[account(address = portal::ID)]
    pub portal_program: UncheckedAccount<'info>,

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

    // --- Base-reward + bucket invariants ---
    validate_base_reward(&base_reward, &ctx.accounts.mint.key())?;
    require!(
        !buckets.is_empty() && buckets.len() <= MAX_BUCKETS,
        GatewayError::InvalidBucketCount
    );

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
    require!(delta > 0, GatewayError::ZeroDelta);
    require!(
        delta >= buckets[0].reward_amount,
        GatewayError::DeltaBelowFloor
    );

    // --- buckets_hash sanity (verify what the user signed matches the args) ---
    let computed_hash: Bytes32 = keccak_buckets(&buckets)?.into();
    require!(
        computed_hash == buckets_hash,
        GatewayError::BucketsHashMismatch
    );

    // --- Single-pass ascending validation + floor selection ---
    let mut k: usize = 0;
    let mut prev = buckets[0].reward_amount;
    for (i, b) in buckets.iter().enumerate().skip(1) {
        require!(
            b.reward_amount > prev,
            GatewayError::BucketsNotAscending
        );
        if b.reward_amount <= delta {
            k = i;
        }
        prev = b.reward_amount;
    }
    let reward_amount_k = buckets[k].reward_amount;
    let route_hash_k = buckets[k].route_hash;

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

    // --- CPI Portal::fund (allow_partial=true → front-run funding is a no-op) ---
    cpi_portal_fund(
        &ctx.accounts.portal_program,
        &ctx.accounts.user,
        &ctx.accounts.user,
        vault_pda_k,
        &ctx.accounts.token_program,
        &ctx.accounts.token_2022_program,
        &ctx.accounts.associated_token_program,
        &ctx.accounts.system_program,
        &[
            ctx.accounts.user_reward_ata.to_account_info(),
            vault_ata_k.to_account_info(),
            ctx.accounts.mint.to_account_info(),
        ],
        FundArgs {
            destination,
            route_hash: route_hash_k,
            reward: reward_k,
            allow_partial: true,
        },
    )?;

    // --- Sweep surplus ---
    let surplus = delta - reward_amount_k;
    if surplus > 0 {
        sweep_surplus(&ctx, surplus)?;
    }

    // --- Event ---
    emit!(IntentSelected::new(
        intent_hash,
        ctx.accounts.user.key(),
        delta,
        k as u64,
        reward_amount_k,
        computed_hash,
    ));

    Ok(())
}

fn validate_base_reward(reward: &Reward, mint_key: &Pubkey) -> Result<()> {
    require!(
        reward.creator != Pubkey::default(),
        GatewayError::InvalidRewardCreator
    );
    require!(
        reward.prover != Pubkey::default(),
        GatewayError::InvalidRewardProver
    );
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

fn keccak_buckets(buckets: &[Bucket]) -> Result<[u8; 32]> {
    // Borsh-serialize `Vec<Bucket>` (length-prefixed) so off-chain builders can
    // reproduce the hash from the same sequence.
    let encoded = buckets.to_vec().try_to_vec()?;
    let mut hasher = Keccak::v256();
    hasher.update(&encoded);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    Ok(out)
}

fn sweep_surplus<'info>(
    ctx: &Context<'_, '_, '_, 'info, CloseAndSelectIntent<'info>>,
    amount: u64,
) -> Result<()> {
    let mint_account = ctx.accounts.mint.to_account_info();
    let token_program = if *mint_account.owner == anchor_spl::token::ID {
        ctx.accounts.token_program.to_account_info()
    } else {
        ctx.accounts.token_2022_program.to_account_info()
    };
    transfer_checked(
        CpiContext::new(
            token_program,
            TransferChecked {
                from: ctx.accounts.user_reward_ata.to_account_info(),
                to: ctx.accounts.sweep_recipient_ata.to_account_info(),
                mint: mint_account,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn cpi_portal_fund<'info>(
    portal_program: &UncheckedAccount<'info>,
    payer: &Signer<'info>,
    funder: &Signer<'info>,
    vault: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    token_2022_program: &Program<'info, Token2022>,
    associated_token_program: &Program<'info, AssociatedToken>,
    system_program: &Program<'info, System>,
    remaining: &[AccountInfo<'info>],
    args: FundArgs,
) -> Result<()> {
    let mut data = FUND_DISCRIMINATOR.to_vec();
    data.extend(args.try_to_vec()?);

    // Portal's `Fund` struct does not mark `payer` as `#[account(mut)]`, but its
    // `fund_context` uses `payer` as the rent source for ATA creation CPI — so we
    // must surface it as writable here, which Anchor's auto-CPI would not do.
    let mut account_metas = vec![
        AccountMeta::new(payer.key(), true),
        AccountMeta::new(funder.key(), true),
        AccountMeta::new(vault.key(), false),
        AccountMeta::new_readonly(token_program.key(), false),
        AccountMeta::new_readonly(token_2022_program.key(), false),
        AccountMeta::new_readonly(associated_token_program.key(), false),
        AccountMeta::new_readonly(system_program.key(), false),
    ];
    for acc in remaining {
        account_metas.push(AccountMeta {
            pubkey: acc.key(),
            is_signer: acc.is_signer,
            is_writable: acc.is_writable,
        });
    }

    let ix = Instruction::new_with_bytes(portal_program.key(), &data, account_metas);

    let mut infos = vec![
        payer.to_account_info(),
        funder.to_account_info(),
        vault.to_account_info(),
        token_program.to_account_info(),
        token_2022_program.to_account_info(),
        associated_token_program.to_account_info(),
        system_program.to_account_info(),
    ];
    infos.extend(remaining.iter().map(ToAccountInfo::to_account_info));

    invoke(&ix, &infos).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    #[test]
    fn fund_discriminator_matches_anchor_convention() {
        let expected = hash(b"global:fund").to_bytes();
        assert_eq!(FUND_DISCRIMINATOR, expected[..8]);
    }
}
