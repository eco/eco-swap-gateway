mod common;

use common::Context;
use solana_sdk::signer::Signer;

// ─── create_intent (route in args) ────────────────────────────────────

#[test]
fn create_intent_success() {
    let mut ctx = Context::new();
    ctx.mint_to_user(1_000_000);

    let ix = ctx.create_intent_ix(vec![0xABu8; 64], 1_000_000);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

#[test]
fn create_intent_partial_balance() {
    let mut ctx = Context::new();
    ctx.mint_to_user(500_000);

    let ix = ctx.create_intent_ix(vec![0xCDu8; 64], 300_000);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), 200_000);
}

// ─── create_intent_from_buffer ────────────────────────────────────────

#[test]
fn create_intent_from_buffer_success() {
    let mut ctx = Context::new();
    ctx.mint_to_user(1_000_000);

    let route = vec![0u8; 128];
    ctx.send(&[ctx.write_route_buffer_ix(route.clone())])
        .unwrap();

    let (buffer_pda, _) = ctx.route_buffer_pda();
    assert!(ctx.account_exists(&buffer_pda));

    let ix = ctx.create_intent_from_buffer_ix(&route, 1_000_000);
    ctx.send(&[ix]).unwrap();

    assert!(!ctx.account_exists(&buffer_pda));
    assert_eq!(ctx.token_balance(&ctx.user_ata()), 0);
}

#[test]
fn create_intent_from_buffer_partial_balance() {
    let mut ctx = Context::new();
    ctx.mint_to_user(2_000_000);

    let route = vec![0xFFu8; 128];
    ctx.send(&[ctx.write_route_buffer_ix(route.clone())])
        .unwrap();

    let ix = ctx.create_intent_from_buffer_ix(&route, 800_000);
    ctx.send(&[ix]).unwrap();

    assert_eq!(ctx.token_balance(&ctx.user_ata()), 1_200_000);
}

// ─── close_route_buffer ───────────────────────────────────────────────

#[test]
fn close_route_buffer_standalone() {
    let mut ctx = Context::new();
    ctx.write_default_route_buffer();

    let (buffer_pda, _) = ctx.route_buffer_pda();
    assert!(ctx.account_exists(&buffer_pda));

    ctx.send(&[ctx.close_route_buffer_ix()]).unwrap();
    assert!(!ctx.account_exists(&buffer_pda));
}

// ─── Error: wrong user on create_intent_from_buffer ───────────────────

#[test]
fn create_intent_from_buffer_fails_with_wrong_user() {
    let mut ctx = Context::new();
    ctx.mint_to_user(1_000_000);
    ctx.write_default_route_buffer();

    let attacker = solana_sdk::signature::Keypair::new();
    ctx.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let ix = ctx.create_intent_from_buffer_ix_as(&attacker.pubkey(), 1_000_000);
    let err = ctx.send_as(&attacker, &[ix]).unwrap_err();

    assert!(
        common::is_anchor_error(&err),
        "Expected constraint failure (PDA seed mismatch), got: {:?}",
        err.err
    );

    let (buffer_pda, _) = ctx.route_buffer_pda();
    assert!(ctx.account_exists(&buffer_pda));
}

// ─── Error: wrong user on close_route_buffer ──────────────────────────

#[test]
fn close_route_buffer_fails_with_wrong_user() {
    let mut ctx = Context::new();
    ctx.write_default_route_buffer();

    let attacker = solana_sdk::signature::Keypair::new();
    ctx.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let ix = ctx.close_route_buffer_ix_as(&attacker.pubkey());
    let err = ctx.send_as(&attacker, &[ix]).unwrap_err();

    assert!(
        common::is_anchor_error(&err),
        "Expected constraint failure, got: {:?}",
        err.err
    );

    let (buffer_pda, _) = ctx.route_buffer_pda();
    assert!(ctx.account_exists(&buffer_pda));
}

// ─── Error: double write_route_buffer ─────────────────────────────────

#[test]
fn write_route_buffer_twice_fails() {
    let mut ctx = Context::new();
    ctx.write_default_route_buffer();

    let err = ctx
        .send(&[ctx.write_route_buffer_ix(vec![0xFFu8; 64])])
        .unwrap_err();

    assert!(
        common::is_anchor_error(&err),
        "Expected PDA init failure, got: {:?}",
        err.err
    );
}
