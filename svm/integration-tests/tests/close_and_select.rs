mod common;

use common::Context;
use eco_svm_std::Bytes32;
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
    let buckets_hash = Context::compute_buckets_hash(&buckets);

    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward: base_reward.clone(),
        buckets: buckets.clone(),
        buckets_hash,
    };
    ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)])
        .unwrap();

    let reward_k = buckets[expected_k].reward_amount;
    let surplus = delta - reward_k;
    let (_, _, vata) = ctx.vault_accounts_for_bucket(DESTINATION, &buckets[expected_k], &base_reward);

    assert_eq!(ctx.token_balance(&ctx.user_ata()), PRE_BALANCE);
    assert_eq!(ctx.token_balance(&vata), reward_k, "vault receives reward_k");
    assert_eq!(ctx.token_balance(&ctx.sweep_recipient_ata()), surplus);
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
        buckets_hash: Context::compute_buckets_hash(&buckets),
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
        buckets_hash: Context::compute_buckets_hash(&buckets),
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
        buckets_hash: Bytes32::from([0u8; 32]),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &[])]);
    assert!(res.is_err(), "empty buckets must revert");
}

#[test]
fn revert_buckets_hash_mismatch() {
    let mut ctx = Context::new();
    let buckets = three_buckets();

    ctx.mint_to_user(PRE_BALANCE);
    ctx.send_as_user(&[ctx.open_ix()]).unwrap();
    ctx.mint_to_user(150_000);

    let base_reward = ctx.base_reward(ctx.unix_now() + 3600);
    let vault_accounts: Vec<_> = buckets
        .iter()
        .map(|b| {
            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);
            (vpda, vata)
        })
        .collect();

    // Wrong hash — should fail BucketsHashMismatch.
    let args = CloseAndSelectArgs {
        destination: DESTINATION,
        base_reward,
        buckets: buckets.clone(),
        buckets_hash: Bytes32::from([0xFFu8; 32]),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)]);
    assert!(res.is_err(), "bad buckets_hash must revert");
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
        buckets_hash: Context::compute_buckets_hash(&buckets),
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
        buckets_hash: Context::compute_buckets_hash(&buckets),
    };

    let res = ctx.send_as_user(&[ctx.close_and_select_ix(args, &vault_accounts)]);
    assert!(res.is_err(), "nonzero native reward must revert");
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
