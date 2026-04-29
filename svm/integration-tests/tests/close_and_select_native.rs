//! Integration tests for `close_and_select_intent_native` — the native-SOL
//! reward variant of the bucketed flow. Mirrors `close_and_select.rs`'s
//! happy and revert paths but with lamport-balance assertions in place of
//! token-balance assertions, and `[vault_pda]` in remaining_accounts (no ATA).

mod common;

use common::{decode_first_event, Context};
use eco_svm_std::Bytes32;
use eco_swap_gateway::events::{IntentFunded, IntentSelected};
use eco_swap_gateway::types::{Bucket, CloseAndSelectArgs};
use solana_sdk::signer::Signer;

const DESTINATION: u64 = 8453; // Base mainnet chain id.
const PRE_BALANCE: u64 = 1_000_000;

/// Same three-bucket fixture as the SPL flow — `reward_amount` is now
/// interpreted as lamports, but the value range is identical.
fn three_buckets() -> Vec<Bucket> {
    vec![
        Bucket {
            route_hash: Context::route_hash_for(0),
            reward_amount: 100_000,
        },
        Bucket {
            route_hash: Context::route_hash_for(1),
            reward_amount: 200_000,
        },
        Bucket {
            route_hash: Context::route_hash_for(2),
            reward_amount: 300_000,
        },
    ]
}

/// Native-flow happy path: open with PRE_BALANCE on user's wSOL ATA, mint
/// `delta` more (mocking Jupiter), then close_and_select_intent_native and
/// assert lamport flows.
fn run_happy_path_native(delta: u64, expected_k: usize) {
    let mut ctx = Context::new_native();
    let buckets = three_buckets();

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(delta);

    let base_reward = ctx.base_reward_native(ctx.unix_now() + 3600);
    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &base_reward).1)
        .collect();
    let buckets_hash = Context::compute_buckets_hash(&buckets);

    let sweep_pre = ctx.lamports(&ctx.sweep_recipient.pubkey());
    let user_wsol_ata = ctx.user_wsol_ata();

    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward: base_reward.clone(),
        buckets: buckets.clone(),
        buckets_hash,
    };
    ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)])
        .unwrap();

    let reward_k = buckets[expected_k].reward_amount;
    let surplus = delta - reward_k;
    let winning_vault_pda = vault_pdas[expected_k];

    // Vault holds exactly reward_k lamports (system::transfer landed cleanly).
    assert_eq!(ctx.lamports(&winning_vault_pda), reward_k, "vault funded");
    // Sweep recipient received exactly `surplus`.
    assert_eq!(
        ctx.lamports(&ctx.sweep_recipient.pubkey()) - sweep_pre,
        surplus,
        "sweep recipient receives surplus"
    );
    // wSOL ATA destroyed by close_account.
    assert!(
        !ctx.account_exists(&user_wsol_ata),
        "user wSOL ATA closed"
    );
    // Snapshot PDA closed; rent refunded to user.
    assert!(
        !ctx.account_exists(&ctx.snapshot_pda_native().0),
        "snapshot closed"
    );
}

// ─── Happy paths ────────────────────────────────────────────────────────────

#[test]
fn happy_path_exact_floor_native() {
    // delta == buckets[0].reward_amount → k=0, surplus=0
    run_happy_path_native(100_000, 0);
}

#[test]
fn happy_path_between_buckets_native() {
    // buckets[1] <= delta < buckets[2] → k=1, surplus=50_000
    run_happy_path_native(250_000, 1);
}

#[test]
fn happy_path_caps_at_top_native() {
    // delta > buckets[N-1].reward_amount → k=N-1, surplus = delta - last
    run_happy_path_native(500_000, 2);
}

// ─── Revert paths ───────────────────────────────────────────────────────────

#[test]
fn revert_delta_below_floor_native() {
    let mut ctx = Context::new_native();
    let buckets = three_buckets();

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(50_000); // below buckets[0] = 100_000

    let base_reward = ctx.base_reward_native(ctx.unix_now() + 3600);
    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &base_reward).1)
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
        buckets_hash: Context::compute_buckets_hash(&buckets),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)]);
    assert!(res.is_err(), "delta below floor must revert");
}

#[test]
fn revert_buckets_not_ascending_native() {
    let mut ctx = Context::new_native();
    let buckets = vec![
        Bucket {
            route_hash: Context::route_hash_for(0),
            reward_amount: 200_000,
        },
        Bucket {
            route_hash: Context::route_hash_for(1),
            reward_amount: 100_000, // out of order
        },
        Bucket {
            route_hash: Context::route_hash_for(2),
            reward_amount: 300_000,
        },
    ];

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(250_000);

    let base_reward = ctx.base_reward_native(ctx.unix_now() + 3600);
    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &base_reward).1)
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
        buckets_hash: Context::compute_buckets_hash(&buckets),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)]);
    assert!(res.is_err(), "non-ascending buckets must revert");
}

#[test]
fn revert_empty_buckets_native() {
    let mut ctx = Context::new_native();
    let buckets: Vec<Bucket> = vec![];

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(100_000);

    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward: ctx.base_reward_native(ctx.unix_now() + 3600),
        buckets,
        buckets_hash: Bytes32::from([0u8; 32]),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &[])]);
    assert!(res.is_err(), "empty buckets must revert");
}

#[test]
fn revert_buckets_hash_mismatch_native() {
    let mut ctx = Context::new_native();
    let buckets = three_buckets();

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(150_000);

    let base_reward = ctx.base_reward_native(ctx.unix_now() + 3600);
    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &base_reward).1)
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
        buckets_hash: Bytes32::from([0xFFu8; 32]),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)]);
    assert!(res.is_err(), "bad buckets_hash must revert");
}

#[test]
fn revert_deadline_expired_native() {
    let mut ctx = Context::new_native();
    let buckets = three_buckets();

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(150_000);

    // deadline of 0 → always expired.
    let base_reward = ctx.base_reward_native(0);
    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &base_reward).1)
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
        buckets_hash: Context::compute_buckets_hash(&buckets),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)]);
    assert!(res.is_err(), "expired deadline must revert");
}

#[test]
fn revert_base_reward_has_tokens_native() {
    use portal::types::TokenAmount;

    let mut ctx = Context::new_native();
    let buckets = three_buckets();

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(150_000);

    // Compute vault PDAs from the empty (valid) reward shape — these don't
    // matter because validate_base_reward_native rejects BEFORE the vault
    // check. We just need any pubkeys in the remaining-accounts slot.
    let valid_reward = ctx.base_reward_native(ctx.unix_now() + 3600);
    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &valid_reward).1)
        .collect();

    // Now mutate the args's base_reward to inject a token entry — this
    // violates `tokens.is_empty()` and must revert.
    let mut bad_reward = valid_reward;
    bad_reward.tokens.push(TokenAmount {
        token: ctx.mint,
        amount: 0,
    });
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward: bad_reward,
        buckets: buckets.clone(),
        buckets_hash: Context::compute_buckets_hash(&buckets),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)]);
    assert!(res.is_err(), "non-empty tokens must revert on native ix");
}

#[test]
fn revert_base_reward_native_amount_nonzero_native() {
    let mut ctx = Context::new_native();
    let buckets = three_buckets();

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(150_000);

    // Template's native_amount must be 0 (filled per-bucket on-chain).
    let mut base_reward = ctx.base_reward_native(ctx.unix_now() + 3600);
    base_reward.native_amount = 1;

    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &base_reward).1)
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
        buckets_hash: Context::compute_buckets_hash(&buckets),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)]);
    assert!(res.is_err(), "nonzero native_amount placeholder must revert");
}

// ─── Event emission ─────────────────────────────────────────────────────────

#[test]
fn emits_intent_selected_and_intent_funded_events_native() {
    let mut ctx = Context::new_native();
    let buckets = three_buckets();
    let expected_k = 1usize;
    let delta = 250_000u64;

    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();
    ctx.mint_to_user_native(delta);

    let base_reward = ctx.base_reward_native(ctx.unix_now() + 3600);
    let vault_pdas: Vec<_> = buckets
        .iter()
        .map(|b| ctx.vault_pda_for_bucket_native(DESTINATION, b, &base_reward).1)
        .collect();

    let (expected_intent_hash, _) =
        ctx.vault_pda_for_bucket_native(DESTINATION, &buckets[expected_k], &base_reward);
    let expected_buckets_hash = Context::compute_buckets_hash(&buckets);

    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
        buckets_hash: expected_buckets_hash,
    };

    let meta = ctx
        .send_as_user(&[ctx.close_and_select_native_ix(args, &vault_pdas)])
        .unwrap();

    let selected = decode_first_event::<IntentSelected>(&meta.logs, "IntentSelected")
        .expect("IntentSelected event missing");
    assert_eq!(selected.intent_hash, expected_intent_hash);
    assert_eq!(selected.user, ctx.user.pubkey());
    assert_eq!(selected.delta, delta);
    assert_eq!(selected.bucket_index, expected_k as u64);
    assert_eq!(selected.reward_amount, buckets[expected_k].reward_amount);
    assert_eq!(selected.buckets_hash, expected_buckets_hash);

    let funded = decode_first_event::<IntentFunded>(&meta.logs, "IntentFunded")
        .expect("IntentFunded event missing");
    assert_eq!(funded.intent_hash, expected_intent_hash);
    assert_eq!(funded.funder, ctx.user.pubkey());
    assert!(funded.complete, "complete must be true");

    // Both events share intent_hash so an indexer can correlate them.
    assert_eq!(selected.intent_hash, funded.intent_hash);
}

// ─── Open sanity ────────────────────────────────────────────────────────────

#[test]
fn open_records_pre_balance_native() {
    let mut ctx = Context::new_native();
    ctx.mint_to_user_native(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix_native()]).unwrap();

    let (snapshot_pk, _) = ctx.snapshot_pda_native();
    let acct = ctx.svm.get_account(&snapshot_pk).unwrap();
    // 8-byte Anchor disc + u64 pre_balance + u8 bump.
    let pre_balance_bytes: [u8; 8] = acct.data[8..16].try_into().unwrap();
    assert_eq!(u64::from_le_bytes(pre_balance_bytes), PRE_BALANCE);
}
