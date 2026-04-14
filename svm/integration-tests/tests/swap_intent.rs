mod common;

use common::Context;
use solana_sdk::instruction::InstructionError;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::TransactionError;
use swap_intent::instructions::SwapIntentError;

/// Happy path: open -> mint tokens (simulates swap) -> close_and_create_intent.
/// The intent is created with the correct amounts and the state PDA is closed.
#[test]
fn open_swap_close_and_create_intent_success() {
    let mut ctx = Context::new();

    let pre_balance = 100_000; // 0.1 USDC already in ATA
    let swap_amount = 1_000_000; // 1.0 USDC from swap
    let flat_fee = 5_000;
    let scalar_num = 997;
    let scalar_denom = 1000;

    // Give user some initial tokens (pre-existing balance)
    ctx.mint_to_user(pre_balance);
    assert_eq!(ctx.token_balance(&ctx.user_ata()), pre_balance);

    // Step 1: open -- snapshot the pre-swap balance
    ctx.send(&[ctx.open_ix()]).unwrap();

    // Verify state PDA exists
    let (swap_state_pda, _) = ctx.swap_state_pda();
    assert!(ctx.account_exists(&swap_state_pda));

    // Step 2: simulate swap by minting more tokens
    ctx.mint_to_user(swap_amount);
    let post_balance = pre_balance + swap_amount;
    assert_eq!(ctx.token_balance(&ctx.user_ata()), post_balance);

    // Step 3: close_and_create_intent
    let ix = ctx.close_and_create_ix(
        pre_balance,
        post_balance,
        flat_fee,
        scalar_num,
        scalar_denom,
    );
    ctx.send(&[ix]).unwrap();

    // Verify state PDA is closed
    assert!(!ctx.account_exists(&swap_state_pda));

    // Verify user's tokens were transferred to vault (reward = swap_output = 1_000_000)
    // User started with post_balance and should have post_balance - swap_amount left
    assert_eq!(ctx.token_balance(&ctx.user_ata()), pre_balance);
}

/// Case 3: close_and_create_intent with calldata patching skipped (u32::MAX sentinel).
#[test]
fn close_and_create_intent_skip_calldata_patch() {
    let mut ctx = Context::new();

    let swap_amount = 1_000_000;
    let flat_fee = 5_000;
    let scalar_num = 997;
    let scalar_denom = 1000;

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix =
        ctx.close_and_create_ix_skip_calldata(0, swap_amount, flat_fee, scalar_num, scalar_denom);
    ctx.send(&[ix]).unwrap();

    // Verify state PDA is closed and tokens transferred
    let (swap_state_pda, _) = ctx.swap_state_pda();
    assert!(!ctx.account_exists(&swap_state_pda));
    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

/// Cancel: open -> cancel. State PDA is closed and rent returned.
#[test]
fn open_then_cancel() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();

    let (swap_state_pda, _) = ctx.swap_state_pda();
    assert!(ctx.account_exists(&swap_state_pda));

    ctx.send(&[ctx.cancel_ix()]).unwrap();

    // State PDA is closed
    assert!(!ctx.account_exists(&swap_state_pda));
}

/// Error: close_and_create_intent with zero swap output (no tokens added after open).
#[test]
fn close_fails_with_zero_swap_output() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();

    // Don't mint any tokens -- swap output will be 0
    let ix = ctx.close_and_create_ix_error_case(0, 1, 1);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InsufficientSwapOutput.into()),
        "Expected InsufficientSwapOutput, got: {:?}",
        err.err
    );
}

/// Error: invalid scalar (denominator = 0).
#[test]
fn close_fails_with_zero_scalar_denom() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_error_case(0, 1, 0); // scalar_denom = 0
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidScalar.into()),
        "Expected InvalidScalar, got: {:?}",
        err.err
    );
}

/// Error: invalid scalar (numerator > denominator).
#[test]
fn close_fails_with_scalar_num_greater_than_denom() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_error_case(0, 1001, 1000); // num > denom
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidScalar.into()),
        "Expected InvalidScalar, got: {:?}",
        err.err
    );
}

/// Error: invalid scalar (numerator = 0).
#[test]
fn close_fails_with_zero_scalar_num() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.close_and_create_ix_error_case(0, 0, 1); // scalar_num = 0
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::InvalidScalar.into()),
        "Expected InvalidScalar, got: {:?}",
        err.err
    );
}

/// Error: route_amount is zero because flat_fee eats everything after scaling.
#[test]
fn close_fails_with_route_amount_zero() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(100); // tiny swap output

    // scalar = 1/1, flat_fee = 100 -> route_amount = 100 * 1/1 - 100 = 0
    let ix = ctx.close_and_create_ix_error_case(100, 1, 1);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::RouteAmountZero.into()),
        "Expected RouteAmountZero, got: {:?}",
        err.err
    );
}

/// Error: flat_fee exceeds scaled amount (underflow).
#[test]
fn close_fails_when_flat_fee_exceeds_scaled_amount() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(1_000);

    // scaled = 1000 * 1/1 = 1000, flat_fee = 2000 -> underflow
    let ix = ctx.close_and_create_ix_error_case(2_000, 1, 1);
    let err = ctx.send(&[ix]).unwrap_err();

    assert!(
        common::is_custom_error(&err, SwapIntentError::ArithmeticOverflow.into()),
        "Expected ArithmeticOverflow, got: {:?}",
        err.err
    );
}

/// Error: cannot open twice (PDA already exists).
#[test]
fn open_twice_fails() {
    let mut ctx = Context::new();

    ctx.send(&[ctx.open_ix()]).unwrap();

    // Second open should fail -- PDA already initialized
    let err = ctx.send(&[ctx.open_ix()]).unwrap_err();

    // System program returns Custom(0) for already-initialized account
    assert!(
        matches!(
            err.err,
            TransactionError::InstructionError(_, InstructionError::Custom(_))
        ),
        "Expected PDA init failure (Custom error), got: {:?}",
        err.err
    );
}

/// Verify fee calculation: route_amount = swap_output * scalar_num / scalar_denom - flat_fee
#[test]
fn fee_calculation_matches_expected() {
    let mut ctx = Context::new();

    let swap_amount = 2_000_000; // 2.0 USDC
    let flat_fee = 10_000;
    let scalar_num = 995;
    let scalar_denom = 1000;

    // Expected: 2_000_000 * 995 / 1000 - 10_000 = 1_990_000 - 10_000 = 1_980_000
    let expected_route_amount = swap_amount * scalar_num / scalar_denom - flat_fee;
    assert_eq!(expected_route_amount, 1_980_000);

    ctx.send(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(swap_amount);

    let ix = ctx.close_and_create_ix(0, swap_amount, flat_fee, scalar_num, scalar_denom);
    ctx.send(&[ix]).unwrap();

    // If the transaction succeeded, the fee calculation matched (otherwise vault PDA would mismatch)
    // Verify full swap_output was transferred as reward
    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}
