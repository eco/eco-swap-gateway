mod common;

use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account;
use anchor_spl::token::spl_token;
use common::Context;
use solana_sdk::instruction::InstructionError;
use solana_sdk::message::Message;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::{Transaction, TransactionError};
use swap_intent::instructions::SwapIntentError;

/// Happy path: write_route_buffer + open -> mint -> close_and_create_intent.
#[test]
fn open_swap_close_and_create_intent_success() {
    let mut ctx = Context::new();

    let pre_balance = 100_000;
    let swap_amount = 1_000_000;
    let flat_fee = 5_000;
    let scalar_num = 997;
    let scalar_denom = 1000;

    ctx.mint_to_user(pre_balance);

    // Setup: write route buffer
    ctx.write_default_route_buffer();

    // Step 1: open
    ctx.send(&[ctx.open_ix()]).unwrap();

    let (swap_state_pda, _) = ctx.swap_state_pda();
    assert!(ctx.account_exists(&swap_state_pda));

    // Step 2: simulate swap
    ctx.mint_to_user(swap_amount);
    let post_balance = pre_balance + swap_amount;

    // Step 3: close_and_create_intent
    let ix = ctx.close_and_create_ix(
        pre_balance,
        post_balance,
        flat_fee,
        scalar_num,
        scalar_denom,
        6,
        6,
        0,
    );
    ctx.send(&[ix]).unwrap();

    assert!(!ctx.account_exists(&swap_state_pda));
    // Route buffer is also closed
    let (route_buffer_pda, _) = ctx.route_buffer_pda();
    assert!(!ctx.account_exists(&route_buffer_pda));
    assert_eq!(ctx.token_balance(&ctx.user_ata()), pre_balance);
}

/// Case 3: calldata patching skipped (u32::MAX sentinel).
#[test]
fn close_and_create_intent_skip_calldata_patch() {
    let mut ctx = Context::new();

    let swap_amount = 1_000_000;
    let flat_fee = 5_000;
    let scalar_num = 997;
    let scalar_denom = 1000;

    // Write route buffer with 0xAB fill and skip-calldata offset
    let ix = ctx.write_route_buffer_ix(vec![0xABu8; 128], 32, u32::MAX);
    ctx.send(&[ix]).unwrap();

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix_skip_calldata(
        0,
        swap_amount,
        flat_fee,
        scalar_num,
        scalar_denom,
        6,
        6,
        0,
    );
    ctx.send(&[ix]).unwrap();

    let (swap_state_pda, _) = ctx.swap_state_pda();
    assert!(!ctx.account_exists(&swap_state_pda));
    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

/// Cancel: open -> cancel.
#[test]
fn open_then_cancel() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();

    let (swap_state_pda, _) = ctx.swap_state_pda();
    assert!(ctx.account_exists(&swap_state_pda));

    ctx.send(&[ctx.cancel_ix()]).unwrap();
    assert!(!ctx.account_exists(&swap_state_pda));
}

/// Error: zero swap output.
#[test]
fn close_fails_with_zero_swap_output() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();

    let ix = ctx.close_and_create_ix_error_case(0, 1, 1, 6, 6);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InsufficientSwapOutput.into()),
        "Expected InsufficientSwapOutput, got: {:?}",
        err.err
    );
}

/// Error: scalar_denom = 0.
#[test]
fn close_fails_with_zero_scalar_denom() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_error_case(0, 1, 0, 6, 6);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidScalar.into()),
        "Expected InvalidScalar, got: {:?}",
        err.err
    );
}

/// Error: scalar_num > scalar_denom.
#[test]
fn close_fails_with_scalar_num_greater_than_denom() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_error_case(0, 1001, 1000, 6, 6);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidScalar.into()),
        "Expected InvalidScalar, got: {:?}",
        err.err
    );
}

/// Error: scalar_num = 0.
#[test]
fn close_fails_with_zero_scalar_num() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_error_case(0, 0, 1, 6, 6);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidScalar.into()),
        "Expected InvalidScalar, got: {:?}",
        err.err
    );
}

/// Error: route_amount zero (flat_fee eats everything).
#[test]
fn close_fails_with_route_amount_zero() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(100);

    let ix = ctx.close_and_create_ix_error_case(100, 1, 1, 6, 6);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::RouteAmountZero.into()),
        "Expected RouteAmountZero, got: {:?}",
        err.err
    );
}

/// Error: flat_fee exceeds scaled amount.
#[test]
fn close_fails_when_flat_fee_exceeds_scaled_amount() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000);

    let ix = ctx.close_and_create_ix_error_case(2_000, 1, 1, 6, 6);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::ArithmeticOverflow.into()),
        "Expected ArithmeticOverflow, got: {:?}",
        err.err
    );
}

/// Error: cannot open twice.
#[test]
fn open_twice_fails() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();

    let err = ctx.send(&[ctx.open_ix()]).unwrap_err();
    assert!(
        matches!(
            err.err,
            TransactionError::InstructionError(_, InstructionError::Custom(_))
        ),
        "Expected PDA init failure, got: {:?}",
        err.err
    );
}

/// Fee calculation verification.
#[test]
fn fee_calculation_matches_expected() {
    let mut ctx = Context::new();

    let swap_amount = 2_000_000;
    let flat_fee = 10_000;
    let scalar_num = 995;
    let scalar_denom = 1000;

    let expected = swap_amount * scalar_num / scalar_denom - flat_fee;
    assert_eq!(expected, 1_980_000);

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix(0, swap_amount, flat_fee, scalar_num, scalar_denom, 6, 6, 0);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

/// Security: wrong user cannot cancel.
#[test]
fn cancel_fails_with_wrong_user() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();

    let (swap_state_pda, _) = ctx.swap_state_pda();
    let attacker = solana_sdk::signature::Keypair::new();
    ctx.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let ix = ctx.cancel_ix_wrong_user(&attacker);
    let err = ctx.send_as(&attacker, &[ix]).unwrap_err();

    assert!(
        matches!(
            err.err,
            TransactionError::InstructionError(_, InstructionError::Custom(_))
        ),
        "Expected constraint failure, got: {:?}",
        err.err
    );
    assert!(ctx.account_exists(&swap_state_pda));
}

/// Security: wrong reward_token.
#[test]
fn close_fails_with_wrong_reward_token() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_wrong_reward_token();
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidMint.into()),
        "Expected InvalidMint, got: {:?}",
        err.err
    );
}

/// Security: wrong token account.
#[test]
fn close_fails_with_wrong_token_account() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let other_holder = solana_sdk::signature::Keypair::new();
    ctx.svm
        .airdrop(&other_holder.pubkey(), 1_000_000_000)
        .unwrap();
    let other_ata = get_associated_token_address(&other_holder.pubkey(), &ctx.mint);
    let create_ata_ix = create_associated_token_account(
        &other_holder.pubkey(),
        &other_holder.pubkey(),
        &ctx.mint,
        &spl_token::ID,
    );
    let tx = Transaction::new(
        &[&other_holder],
        Message::new(&[create_ata_ix], Some(&other_holder.pubkey())),
        ctx.svm.latest_blockhash(),
    );
    ctx.svm.send_transaction(tx).unwrap();

    let ix = ctx.close_and_create_ix_wrong_token_account(other_ata);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidTokenAccount.into()),
        "Expected InvalidTokenAccount, got: {:?}",
        err.err
    );
}

// ─── Decimal Conversion Tests ──────────────────────────────────────────

#[test]
fn decimal_conversion_same_decimals() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix(0, 1_000_000, 5_000, 997, 1000, 6, 6, 0);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

#[test]
fn decimal_conversion_6_to_18() {
    let mut ctx = Context::new();

    let swap_amount = 18_400_000_000u64;

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix(0, swap_amount, 0, 1, 1, 6, 18, 0);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

#[test]
fn decimal_conversion_18_to_6() {
    let mut ctx = Context::new();

    let swap_amount = 2_000_000_000_000u64;

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix(0, swap_amount, 0, 1, 1, 18, 6, 0);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

#[test]
fn decimal_conversion_truncates_to_zero() {
    let mut ctx = Context::new();

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_error_case(0, 1, 1, 18, 6);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::RouteAmountZero.into()),
        "Expected RouteAmountZero, got: {:?}",
        err.err
    );
}

// ─── Custom Reward Amount Tests ────────────────────────────────────────

#[test]
fn default_reward_uses_full_swap_output() {
    let mut ctx = Context::new();

    let pre_balance = 100_000;
    let swap_amount = 1_000_000;

    ctx.mint_to_user(pre_balance);
    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix(pre_balance, pre_balance + swap_amount, 0, 1, 1, 6, 6, 0);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), pre_balance);
}

#[test]
fn custom_reward_amount() {
    let mut ctx = Context::new();

    let swap_amount = 1_000_000;
    let custom_reward = 600_000;

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix(0, swap_amount, 0, 1, 1, 6, 6, custom_reward);
    ctx.send(&[ix]).unwrap();

    assert_eq!(
        ctx.token_balance(&ctx.user_ata()),
        swap_amount - custom_reward
    );
}

#[test]
fn close_fails_with_reward_exceeds_swap_output() {
    let mut ctx = Context::new();

    let swap_amount = 1_000_000;

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix_error_case_with_reward(swap_amount + 1);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::RewardExceedsSwapOutput.into()),
        "Expected RewardExceedsSwapOutput, got: {:?}",
        err.err
    );
}

#[test]
fn integration_custom_reward_vault_balance() {
    let mut ctx = Context::new();

    let swap_amount = 1_000_000;
    let custom_reward = 700_000;

    ctx.write_default_route_buffer();
    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix(0, swap_amount, 0, 1, 1, 6, 6, custom_reward);
    ctx.send(&[ix]).unwrap();

    assert_eq!(
        ctx.token_balance(&ctx.user_ata()),
        swap_amount - custom_reward
    );
}
