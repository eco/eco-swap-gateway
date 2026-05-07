mod common;

use common::{decode_first_event, logs_show_invoke_of, Context};
use eco_swap_gateway::events::{IntentFunded, IntentSelected};
use eco_swap_gateway::types::{Bucket, CloseAndSelectArgs};

const DESTINATION: u64 = 8453; // Base mainnet chain id.
const PRE_BALANCE: u64 = 1_000_000;

/// Helper: compile three strictly-ascending test buckets.
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

/// Run the open → simulated-swap → close_and_select happy-path scaffold and
/// assert the three post-tx balance invariants:
///   user_ata   = PRE_BALANCE                     (original balance restored)
///   vault_ata  = buckets[expected_k].reward_amount
///   sweep_ata  = delta - buckets[expected_k].reward_amount   (surplus)
fn run_happy_path(delta: u64, expected_k: usize) {
    let mut ctx = Context::new();
    let buckets = three_buckets();

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(delta);

    let base_reward = ctx.base_reward(ctx.unix_now() + 3600);
    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward: base_reward.clone(),
        buckets: buckets.clone(),
    };
    ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)])
        .unwrap();

    let reward_k = buckets[expected_k].reward_amount;
    let surplus = delta - reward_k;
    let (_, _, vata) = ctx.vault_accounts_for_bucket(DESTINATION, &buckets[expected_k], &base_reward);

    assert_eq!(ctx.token_balance(&ctx.user_ata()), PRE_BALANCE);
    assert_eq!(ctx.token_balance(&vata), reward_k, "vault receives reward_k");
    assert_eq!(ctx.token_balance(&ctx.sweep_recipient_token_account()), surplus);
    assert!(!ctx.account_exists(&ctx.snapshot_pda().0), "snapshot closed");
}

// ─── Happy paths ────────────────────────────────────────────────────────────

#[test]
fn happy_path_exact_floor() {
    // delta == buckets[0].reward_amount → k=0, surplus=0
    run_happy_path(100_000, 0);
}

#[test]
fn happy_path_between_buckets() {
    // buckets[1] <= delta < buckets[2] → k=1, surplus=50_000
    run_happy_path(250_000, 1);
}

#[test]
fn happy_path_caps_at_top() {
    // delta > buckets[N-1].reward_amount → k=N-1, surplus = delta - last
    run_happy_path(500_000, 2);
}

// ─── Revert paths ───────────────────────────────────────────────────────────

#[test]
fn revert_delta_below_floor() {
    let mut ctx = Context::new();
    let buckets = three_buckets();

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(50_000); // below buckets[0] = 100_000

    let base_reward = ctx.base_reward(ctx.unix_now() + 3600);
    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)]);
    assert!(res.is_err(), "delta below floor must revert");
}

#[test]
fn revert_buckets_not_ascending() {
    let mut ctx = Context::new();
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

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(250_000);

    let base_reward = ctx.base_reward(ctx.unix_now() + 3600);
    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)]);
    assert!(res.is_err(), "non-ascending buckets must revert");
}

#[test]
fn revert_empty_buckets() {
    let mut ctx = Context::new();
    let buckets: Vec<Bucket> = vec![];

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(100_000);

    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward: ctx.base_reward(ctx.unix_now() + 3600),
        buckets,
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &[])]);
    assert!(res.is_err(), "empty buckets must revert");
}

#[test]
fn revert_deadline_expired() {
    let mut ctx = Context::new();
    let buckets = three_buckets();

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(150_000);

    // deadline of 0 → always expired.
    let base_reward = ctx.base_reward(0);
    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)]);
    assert!(res.is_err(), "expired deadline must revert");
}

#[test]
fn revert_base_reward_native_nonzero() {
    let mut ctx = Context::new();
    let buckets = three_buckets();

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(150_000);

    let mut base_reward = ctx.base_reward(ctx.unix_now() + 3600);
    base_reward.native_amount = 1; // v1 requires 0

    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)]);
    assert!(res.is_err(), "nonzero native reward must revert");
}

// ─── Event emission ─────────────────────────────────────────────────────────

#[test]
fn emits_intent_selected_and_intent_funded_events() {
    use solana_sdk::signer::Signer;

    let mut ctx = Context::new();
    let buckets = three_buckets();
    let expected_k = 1usize;
    let delta = 250_000u64;

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(delta);

    let base_reward = ctx.base_reward(ctx.unix_now() + 3600);
    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();

    let (expected_intent_hash, _, _) =
        ctx.vault_accounts_for_bucket(DESTINATION, &buckets[expected_k], &base_reward);

    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
    };

    let meta = ctx
        .send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)])
        .unwrap();

    let selected = decode_first_event::<IntentSelected>(&meta.logs, "IntentSelected")
        .expect("IntentSelected event missing");
    assert_eq!(selected.intent_hash, expected_intent_hash);
    assert_eq!(selected.user, ctx.user.pubkey());
    assert_eq!(selected.delta, delta);
    assert_eq!(selected.bucket_index, expected_k as u64);
    assert_eq!(selected.reward_amount, buckets[expected_k].reward_amount);

    let funded = decode_first_event::<IntentFunded>(&meta.logs, "IntentFunded")
        .expect("IntentFunded event missing");
    assert_eq!(funded.intent_hash, expected_intent_hash);
    assert_eq!(funded.funder, ctx.user.pubkey());
    assert!(funded.complete, "complete must be true — single-token, full-amount invariant");

    // Sanity: both events carry the same intent hash so an indexer keying on
    // it can correlate them.
    assert_eq!(selected.intent_hash, funded.intent_hash);
}

#[test]
fn idempotent_over_preexisting_vault_ata() {
    // Same happy-path assertions as `happy_path_between_buckets`, but we
    // pre-create the winning bucket's vault ATA before calling
    // close_and_select_intent — exercising the `data_is_empty()` branch
    // that skips the create CPI.
    use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account;
    use solana_sdk::message::Message;
    use solana_sdk::signer::Signer;
    use solana_sdk::transaction::Transaction;

    let mut ctx = Context::new();
    let buckets = three_buckets();
    let expected_k = 1usize;
    let delta = 250_000;

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(delta);

    let base_reward = ctx.base_reward(ctx.unix_now() + 3600);
    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();
    let (winning_vpda, _) = vault_accounts[expected_k];

    // Pre-create the winning vault ATA using a different payer so rent is
    // already accounted for when close_and_select_intent runs.
    let create_ata_ix = create_associated_token_account(
        &ctx.mint_authority.pubkey(),
        &winning_vpda,
        &ctx.mint,
        &anchor_spl::token::ID,
    );
    let tx = Transaction::new(
        &[&ctx.mint_authority],
        Message::new(&[create_ata_ix], Some(&ctx.mint_authority.pubkey())),
        ctx.svm.latest_blockhash(),
    );
    ctx.svm.send_transaction(tx).unwrap();

    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward: base_reward.clone(),
        buckets: buckets.clone(),
    };
    let meta = ctx
        .send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)])
        .unwrap();

    let reward_k = buckets[expected_k].reward_amount;
    let surplus = delta - reward_k;
    let (_, _, vata) =
        ctx.vault_accounts_for_bucket(DESTINATION, &buckets[expected_k], &base_reward);

    assert_eq!(ctx.token_balance(&ctx.user_ata()), PRE_BALANCE);
    assert_eq!(ctx.token_balance(&vata), reward_k);
    assert_eq!(ctx.token_balance(&ctx.sweep_recipient_token_account()), surplus);

    // Positive control: the token program MUST be invoked for the two
    // `transfer_checked` CPIs (fund + surplus sweep). Asserting this first
    // confirms `logs_show_invoke_of` is working against this test's log
    // format before we trust the negative assertion below.
    assert!(
        logs_show_invoke_of(&meta.logs, &anchor_spl::token::ID),
        "sanity: spl-token program must have been invoked; logs: {:?}",
        meta.logs
    );
    // Prove the `data_is_empty()` skip branch was actually taken — if the
    // instruction had fallen through to `associated_token::create`, the ATA
    // program would appear as `Program <id> invoke [N]` in the logs.
    assert!(
        !logs_show_invoke_of(&meta.logs, &anchor_spl::associated_token::ID),
        "associated_token_program should not have been invoked; logs: {:?}",
        meta.logs
    );
}

// ─── Open sanity ────────────────────────────────────────────────────────────

#[test]
fn open_records_pre_balance() {
    let mut ctx = Context::new();
    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();

    let (snapshot_pk, _) = ctx.snapshot_pda();
    let acct = ctx.svm.get_account(&snapshot_pk).unwrap();
    // Anchor discriminator (8 bytes) + u64 pre_balance (8 bytes) + u8 bump.
    let pre_balance_bytes: [u8; 8] = acct.data[8..16].try_into().unwrap();
    assert_eq!(u64::from_le_bytes(pre_balance_bytes), PRE_BALANCE);
}
