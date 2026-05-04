# Eco — Swap Intent Helper · Cantina audit findings

Source: https://cantina.xyz/code/1a093301-e0b1-42d6-ae85-71050f5b1dae/findings
Extracted: 2026-05-01T07:12:59.688Z
Total: 14 findings

## Index

- **#14** [Medium · New] Missing minimum deadline validation allows intent creator to drain vault via refund_intent after solver delivery
- **#13** [Informational · New] Residual DEX allowances persisting on the gateway after swap execution may be risky
- **#12** [Informational · New] Unvalidated `destination` chain ID allows creation of permanently unfillable intents
- **#11** [Informational · New] Unconstrained `swapCalls` allow drain of gateway-held funds by a malicious front-end
- **#10** [Informational · New] Lack of circuit-breakers may be risky
- **#9** [Informational · New] Unused error variant `InvalidSweepRecipient`
- **#8** [Informational · New] Specified known limitations and accepted risks
- **#7** [Informational · New] Inconsistency in specification and implementation of `swapOutput` and `routeAmount`
- **#6** [Informational · New] Misleading use of "ATA" for generic token accounts
- **#5** [Low · New] No minimum retention floor allows malicious Solver to extract full `swapOutput` while delivering negligible `routeAmount`
- **#4** [Informational · New] Asymmetry between rebasing `outputToken` on EVM and explicit denylist on SVM
- **#3** [Low · New] Solver trust assumptions in `swapAndSelectIntent` may be risky
- **#2** [Informational · New] Delegating slippage protection to `swapCalls` risks unexpected swap outputs
- **#1** [Informational · New] Incorrect `calldataAmountOffset` produces funded but unfillable intent

---

# Finding #14 — Missing minimum deadline validation allows intent creator to drain vault via refund_intent after solver delivery

- **Status:** New
- **Severity:** Medium (Likelihood Low, Impact High)
- **Creator:** Matías Barrios
- **Created:** Apr 30, 2026 at 12:09
- **Code:**
  - [svm/programs/eco-swap-gateway/src/instructions/close_and_select_intent.rs](https://cantina.xyz/code/1a093301-e0b1-42d6-ae85-71050f5b1dae/svm/programs/eco-swap-gateway/src/instructions/close_and_select_intent.rs#L83)

## Description

The `close_and_select_intent` instruction accepts a `base_reward` struct as a user-supplied argument and uses its fields — `creator`, `prover`, and `deadline` — to deterministically derive the `intent_hash` and, subsequently, the Portal vault PDA that receives the reward tokens.
As shown in the code snippet below, the `validate_base_reward` function enforces only that `creator != Pubkey::default()`, `prover != Pubkey::default()`, `native_amount == 0`, `tokens.len() == 1`, `tokens[0].token == mint`, and `tokens[0].amount == 0`.
There is no requirement that `base_reward.deadline` be sufficiently far in the future beyond a trivial `> now` check.

```
fn validate_base_reward(reward: &Reward, mint_key: &Pubkey) -> Result<()> {    require!(        reward.creator != Pubkey::default(),        GatewayError::InvalidRewardCreator    );    require!(        reward.prover != Pubkey::default(),        GatewayError::InvalidRewardProver    );    require!(reward.native_amount == 0, GatewayError::InvalidBaseRewardNative);    require!(reward.tokens.len() == 1, GatewayError::InvalidBaseRewardTokens);    require!(        reward.tokens[0].token == *mint_key,        GatewayError::MintMismatch    );    require!(        reward.tokens[0].amount == 0,        GatewayError::InvalidBaseRewardAmount    );    Ok(())}
```

The deadline is validated separately in the instruction body with only the following check:

```
require!(base_reward.deadline > now, GatewayError::DeadlineExpired);
```

In the normal flow, the Solver constructs the transaction and sets the deadline with a sufficient settlement window. However, the user is the sole signer of the transaction — nothing on-chain prevents the user from modifying the deadline before signing. This allows the user to set `deadline = now + 1`, creating an intent that expires almost immediately. Modifying the deadline produces a different `intent_hash` (and therefore a different vault PDA), but the vault functions identically regardless of the deadline value.
If the Solver were to fulfill an intent without verifying that the deadline provides sufficient time for the prove → Hyperlane → withdraw flow to complete, the user could call `Portal::refund_intent` after the deadline expires and before the `Proof` account is created, draining the vault while the Solver's delivery is already in flight.
Risk
To understand the risk, it is important to describe the correct solver claim flow. Once a solver delivers tokens to the user on the destination chain, the protocol requires:

- The solver calls `fulfill` on the destination chain, delivering tokens to the user and creating a `FulfillMarker`.
- The `prove` instruction reads the `FulfillMarker` and dispatches a Hyperlane message back to Solana, where a `Proof` account is created.
- The solver calls `withdraw` on Solana, presenting the `Proof` account to claim the vault tokens.
Portal's `refund_intent` uses the existence of the `Proof` account as the sole guard against refund: if the proof already exists, the refund fails; if it does not, the refund succeeds. This is the correct design — if the proof exists, the solver delivered and deserves payment regardless of when they call `withdraw`. The deadline is only relevant for the refund path: `refund_intent` requires both that the deadline has expired and that no proof exists.
A short deadline therefore creates a race condition between the user calling `refund_intent` (available as soon as the deadline expires) and the prover creating the `Proof` account (which depends on destination chain finality and prover latency). A user who sets `base_reward.creator = user` and a deadline short enough to expire before the prover can generate the proof can drain the vault while the solver's delivery is already in flight.
A particularly concrete attack exploits mempool visibility on the destination chain: a malicious user can monitor the destination chain mempool and, the moment the solver's `fulfill` transaction appears (even before it is confirmed), immediately call `refund_intent` on Solana. Because the `fulfill` has not yet been confirmed and the `prove` → Hyperlane → `handle` flow has not started, the `Proof` account does not exist and the refund succeeds. The solver loses the tokens they just delivered with no recourse.
Mitigating factors
The following off-chain properties significantly reduce the practical exploitability of this issue:

- Solver = filler by construction. Route bytes live only in the Solver's database. Only the Solver that quoted the user can fulfill the resulting intent. If the user modifies the deadline, the `intent_hash` changes and the Solver would not recognize or fulfill the modified intent.
- Solver controls the deadline. In the normal flow, the Solver constructs the transaction and sets a deadline with sufficient settlement window. A rational Solver would never fulfill an intent with an insufficient deadline.
- Deadline-based refund is a designed safety net. Per the protocol design, `Portal::refund` is the user's recourse if the Solver fails to fulfill before the deadline. The refund path is intentional, not a vulnerability.
These mitigations hold as long as the Solver validates the deadline before fulfilling. However, no on-chain enforcement exists to guarantee this behavior.
Attack example

- (user) Requests a quote from the Solver to obtain the intent parameters (buckets, route hashes, reward amounts). Modifies the Solver's transaction to set `base_reward.deadline = now + 1` before signing.
- (user) Signs and sends the transaction: `open` → Jupiter swap → `close_and_select_intent` (vault receives `reward_amount_k`, surplus swept back to user).
- (Solver) Detects the `IntentSelected` event and calls `fulfill` on the destination chain without verifying that the deadline allows sufficient time for the prove → Hyperlane → withdraw flow.
- (user) After the deadline expires (within seconds), calls `Portal::refund_intent` on Solana. The `Proof` account does not yet exist — the refund succeeds, draining the vault.
Result: the user recovers the full vault amount via refund while also receiving the tokens delivered by the Solver on the destination chain. The Solver cannot recover their payment.
Affected Assets

- `programs/eco-swap-gateway/src/instructions/close_and_select_intent.rs`
Test Scenarios

- TS-43: for close_and_select_intent, base_reward.deadline must be validated to enforce a minimum duration
- TS-44: for close_and_select_intent, the user must not be able to recover vault tokens via Portal refund_intent
- TS-45: for close_and_select_intent, a solver who delivers on the destination chain must not lose their payment due to a user-initiated vault refund

## Proof of Concept

The following test demonstrates the attack using LiteSVM. A user sets `deadline = now + 1` and drains the vault via `refund_intent` before the proof is created.
Source: `tests/tests/refund_exploit.rs`

```
/// Attack scenario: the user calls `refund_intent` in the window between/// deadline expiry and proof creation, draining the vault before the solver can/// claim their reward.////// The solver delivers tokens to the user on the destination chain in good faith./// While the prover is generating the proof (which requires destination chain/// finality), the deadline expires and the user calls `refund_intent`. Because/// the Proof account does not yet exist, `is_fulfilled` returns false and the/// refund succeeds.////// At the end of the test we also simulate "late" proof creation (injecting the/// Proof account after the refund) to show that even if the proof arrives, it/// is now too late: the vault ATA is already closed and the solver has no/// on-chain path to recover their payment.#[test]fn ts44_attack_refund_before_proof_leaves_solver_uncompensated() {    let mut ctx = TestContext::new();    let buckets = three_buckets();    let delta = 250_000u64;    let expected_k = 1usize;    let reward_amount_k = buckets[expected_k].reward_amount; // 200_000    let surplus = delta - reward_amount_k;                   // 50_000
    // deadline = now + 1: short enough that the user can call refund_intent    // before the prover finishes generating the proof.    let deadline = ctx.unix_now() + 1;
    let base_reward = portal::types::Reward {        deadline,        creator: ctx.user.pubkey(), // user as creator — no restriction in eco-swap-gateway        prover: ctx.prover,        native_amount: 0,        tokens: vec![TokenAmount { token: ctx.mint, amount: 0 }],    };
    // The user's own ATA is used as sweep_recipient — surplus goes back to them.    let vault_accounts: Vec<(_, _)> = buckets        .iter()        .map(|b| {            let (_, vpda, vata) = ctx.vault_accounts_for_bucket(DESTINATION, b, &base_reward);            (vpda, vata)        })        .collect();
    // ── Step 1: open ───────────────────────────────────────────────────────    ctx.mint_to_user(PRE_BALANCE);    ctx.send_as_user(&[ctx.open_ix()]).expect("open must succeed");
    // ── Step 2: Jupiter swap (simulated) ────────────────────────────────────    // In production, Jupiter executes the swap atomically between open and    // close_and_select_intent; delta is determined by the execution price.    // Here we simulate it via mint_to_user(delta). This does not affect the    // PoC result because close_and_select_intent only measures the difference    // between the current ATA balance and the snapshot taken in open — it does    // not validate the source of the tokens.    ctx.mint_to_user(delta); // delta = 250_000 → k=1, reward=200_000, surplus=50_000
    // ── Step 3: close_and_select_intent ──────────────────────────────────────    let (intent_hash, vault_pda_k, vault_ata_k) =        ctx.vault_accounts_for_bucket(DESTINATION, &buckets[expected_k], &base_reward);
    ctx.send_as_user(&[ctx.close_and_select_ix_with_sweep(        CloseAndSelectArgs {            destination: DESTINATION,            base_reward: base_reward.clone(),            buckets: buckets.clone(),        },        &vault_accounts,        ctx.user_ata(), // sweep_recipient = user's own ATA    )])    .expect("close_and_select must succeed");
    // surplus returned to user's ATA via sweep; only reward_amount_k left the user.    assert_eq!(ctx.token_balance(&ctx.user_ata()), PRE_BALANCE + surplus);    assert_eq!(ctx.token_balance(&vault_ata_k), reward_amount_k);
    // ── At this point the solver submits a deposit tx on the destination chain ─    // The solver sees the intent on-chain and submits a deposit transaction on    // the destination chain. It does not need to be confirmed — the malicious    // user can call refund_intent as soon as the tx appears in the mempool.
    // ── Step 4: deadline expires before proof is created ─────────────────────    let mut clock = ctx.svm.get_sysvar::<Clock>();    clock.unix_timestamp = deadline as i64 + 1;    ctx.svm.set_sysvar(&clock);
    // ── Step 5: user calls refund_intent — proof does not yet exist ──────────    // is_fulfilled(proof) returns false → RewardNotExpired check passes →    // vault is drained to the user's primary ATA.    let refund_ix = build_refund_ix(        &ctx, &buckets, &base_reward, expected_k, intent_hash, vault_pda_k, vault_ata_k,    );    ctx.send_as_user(&[refund_ix]).expect("refund_intent must succeed (proof not yet created)");
    assert_eq!(        ctx.token_balance(&ctx.user_ata()),        PRE_BALANCE + delta,        "user recovered full delta — surplus via sweep + reward_amount_k via refund"    );    assert_eq!(ctx.token_balance(&vault_ata_k), 0, "vault drained");}
```

## Recommendation

- Enforce a protocol-defined minimum deadline in `validate_base_reward`. Require that `base_reward.deadline >= now + MIN_SOLVER_WINDOW`, where `MIN_SOLVER_WINDOW` reflects the worst-case time needed for a solver to complete cross-chain delivery, generate a proof, and submit the on-chain claim. This eliminates the ability to set a deadline so short that `refund_intent` can be called before any solver can settle.

```
require!(    reward.deadline >= now + MIN_SOLVER_WINDOW,    GatewayError::DeadlineExpired);
```

- 
If a user-facing UI exists, it should display a clear warning when the selected deadline is close to the minimum, informing the user that solvers may refuse to fulfill intents with insufficient settlement windows.

- 
Solvers should verify programmatically that `reward.deadline - now >= expected_settlement_time` before committing to cross-chain delivery, where `expected_settlement_time` accounts for destination chain finality, prover latency, and claim transaction confirmation. This check should be documented as a required safety step in the solver integration guide.

Important Note: The value of `MIN_SOLVER_WINDOW` should reflect the maximum expected cross-chain finality time for the supported destination chains, accounting for worst-case prover latency.

## Reference

Hyperlane
Hyperlane offers two products: a [messaging layer](https://docs.hyperlane.xyz/docs/intro) for arbitrary cross-chain messages, and [Warp Routes](https://docs.hyperlane.xyz/docs/protocol/warp-routes/warp-routes-types) for token bridging. Warp Routes lock tokens as collateral on the source chain and mint/release equivalent tokens on the destination chain only after message verification — if used, the solver's delivery would be conditional on cross-chain verification, preventing the race condition.
However, Warp Routes require implementation on both sides of the bridge (lock on one chain, mint/release on the other). The absence of any Warp Route implementation in Portal's Solana program — no lock, collateral, synthetic, or mint logic exists in the audited codebase — is a strong indicator that Warp Routes are not being used for this flow.
Given this, it is valid to assume that Portal uses Hyperlane exclusively as a messaging layer via the `hyper-prover` program. Hyperlane's messaging model works as follows:

"To send interchain messages, developers call `Mailbox.dispatch()`"

"If the ISM successfully verifies the message, the Mailbox delivers the message to the recipient by calling `recipient.handle()`."

In Portal's flow, the Hyperlane message travels in the direction destination → source (proof sent back after delivery):

- (solver) Calls `fulfill` on the destination chain independently, without requiring any prior authorization from the source chain. Tokens are delivered to the user.
- (HyperProver) After `fulfill` executes, the HyperProver dispatches a Hyperlane message back to Solana via `Mailbox.dispatch()`.
- (Hyperlane) The Interchain Security Module (ISM) verifies the message on Solana.
- (Solana) The Mailbox delivers the message by calling `recipient.handle()`, which creates the `Proof` account on Solana.
Because delivery (step 1) happens before proof creation (step 4), a race condition window exists where the malicious user can call `refund_intent` before the Hyperlane message reaches Solana. Neither Hyperlane's messaging layer nor Portal impose a minimum deadline, so the responsibility of enforcing a safe deadline window falls on eco-swap-gateway.
Wormhole
As an industry reference, Wormhole's Wrapped Token Transfers (WTT) eliminates this class of vulnerability entirely by making token release on the destination chain conditional on a cryptographically verified message from the source chain (VAA). In Wormhole's model, no tokens are released on the destination chain until the VAA is verified:

"The VAA must be submitted to the WTT contract on the destination chain to complete the transfer. The WTT contract then verifies the VAA by calling the Core Contract behind the scenes."

"After the VAA is verified on the destination chain, the WTT contract completes the transfer"

This means a solver cannot deliver tokens independently and then prove it later — the delivery itself requires prior authorization from the source chain via Guardian consensus, eliminating the race condition between delivery and proof creation.
Sources:

- Intro to Hyperlane | Hyperlane Docs
- Flow of Wrapped Token Transfers (WTT) | Wormhole Docs

# Finding #13 — Residual DEX allowances persisting on the gateway after swap execution may be risky

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 30, 2026 at 06:48

## Description

`_executeSwap(...)` executes caller-supplied `swapCalls` which typically include a token approval to a DEX target. While `_cleanup(...)` sweeps residual token balances, it does not revoke these approvals. If a DEX partially consumes an allowance, or if `swapCalls` includes an approval that was never consumed, the gateway retains a non-zero allowance to an external DEX contract across transactions.
While the gateway holds no persistent token balances between calls, a future transaction that routes through the same token could briefly expose those tokens to the DEX's `transferFrom(...)`. The risk is bounded to the window between `safeTransferFrom` (tokens enter gateway) and the swap consuming them, but the residual allowance extends the attack surface if the approved DEX is later exploited or behaves adversarially.

## Recommendation

Consider:

- A caller-supplied revoke list `address[] calldata targets` parameter where:
`_cleanup(...)` calls `forceApprove(target, 0)` for each unconditionally. orRequire zero allowance post-swap where assert `IERC20(inputToken).allowance(address(this), target) == 0` for each known target after `swapCalls`, which forces callers to include explicit revoke calls in `swapCalls`.

- Warn users about revoking allowances within `swapCalls` at a minimum.

# Finding #12 — Unvalidated `destination` chain ID allows creation of permanently unfillable intents

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 30, 2026 at 06:41

## Description

Both `swapAndCreateIntent(...)` and `swapAndSelectIntent(...)` pass destination to `PORTAL.publishAndFund(...)` / `PORTAL.fund(...)` without any validation. (Any validation inside PORTAL is outside the gateway's scope and unverifiable without reviewing the Portal source.)
A wrong, zero, or nonexistent chain ID produces an intent no solver can fulfill. The user's `outputToken` is locked in the `PORTAL` vault until `reward.deadline` expires.

## Recommendation

Consider validating `destination` chain ID in `EcoSwapGateway` to fail early.

---

# Finding #11 — Unconstrained `swapCalls` allow drain of gateway-held funds by a malicious front-end

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 30, 2026 at 06:34

## Description

`_executeSwap(...)` pulls `inputToken` into the gateway then executes caller-supplied `swapCalls` with no validation on targets or calldata. A malicious frontend can inject a `swapCall` that drains `inputToken` (or native ETH) from the gateway between the `safeTransferFrom` pull and the swap execution. For example, a call encoding `inputToken.transfer(attacker, inputAmount)` executes from the gateway's context, draining the just-transferred funds before the swap runs.

## Recommendation

Given that there is no reasonable onchain fix without restricting call targets to a known DEX allowlist, which would break the permissionless design, consider warning users about this risk and that they should not blind-sign `swapCall` targets and selectors.

# Finding #10 — Lack of circuit-breakers may be risky

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 30, 2026 at 03:33

## Description

The current Gateway implementation does not have any administrative circuit-breakers to pause the contract in case of any unexpected emergency. This is specified as out-of-scope for this version.

## Recommendation

Consider adding this security measure appropriately.

---

# Finding #9 — Unused error variant `InvalidSweepRecipient`

- **Status:** New
- **Severity:** Informational
- **Creator:** Matías Barrios
- **Created:** Apr 30, 2026 at 02:37

Description
The error variant `GatewayError::InvalidSweepRecipient` is defined in `errors.rs` with the message `"sweep_recipient_ata must not belong to the program or the Portal."`, but it is never referenced in any instruction. The EVM contract enforces this check (`sweepRecipient != address(this)` and `!= portal`), but the SVM program does not.

```
#[msg("sweep_recipient_ata must not belong to the program or the Portal.")]InvalidSweepRecipient,
```

This appears to be either a planned check that was not implemented or a remnant from a removed validation.
Recommendation
Remove the unused error variant to avoid confusion.

---

# Finding #8 — Specified known limitations and accepted risks

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 30, 2026 at 01:47

## Description

The specification summarizes the following known limitations that are accepted risks:

- Quantization loss. Outputs between bucket floors round down to bucket `k`; surplus flows to `sweepRecipient`, so no value is destroyed but destination `route_amount` is fixed to the bucket floor.
- Per-quote ALT latency (SVM). ~1 slot between quote acceptance and tx send for ALT activation. ALT lifecycle (deactivate + close + rent reclaim) is a Solver-ops concern.
- N <= 14 (SVM). Hard-capped by program constant, bound by ix-data size against Solana's 1232-byte packet limit.
- Front-run funding. A third party calling `Portal::fund` for the same vault first triggers the `onlyFundable` modifier's early-return; EcoSwapGateway's fund call becomes a no-op and the swap output is swept to `sweepRecipient`. User's gas is lost, no value destroyed. Practically EVM-only.
- No `IntentFunded` event on race-loss (EVM). Because the `onlyFundable` modifier short-circuits before `_fundIntent`'s body runs, EcoSwapGateway's race-loss path emits no `IntentFunded` from Portal. `IntentSelected` from EcoSwapGateway still fires, so the Solver must subscribe to `IntentSelected` (not only `IntentFunded`) to detect race-loss and fulfill the intent.
- Solver fulfillment SLA. If the Solver fails to fulfill the funded intent after the user tx lands, the user's reward sits in the vault until `Portal::refund` returns funds at `reward.deadline`. Audit-relevant: this is the only path where a successful user tx can result in temporarily stranded funds (until refund). No other party can fulfill — the Solver is the only entity holding the route bytes.
- No on-chain attestation that the Solver-claimed `routeHash_k` corresponds to the route bytes the user inspected pre-sign. Pre-signing inspection is the user's defence; deadline-based refund is the post-tx defence.

## Recommendation

Consider surfacing these limitations/risks appropriately to the users/integrators.

---

# Finding #7 — Inconsistency in specification and implementation of `swapOutput` and `routeAmount`

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 30, 2026 at 01:11

## Description

The specification says that "The reward is the full swap output after a caller-supplied fee scalar". However, the fee (scalar + flat) only reduces the `routeAmount` on destination chain while the solver reward on source chain is the entire `swapOutput`.

## Recommendation

Consider updating the specification to remove this inconsistency given that the implementation is correct.

---

# Finding #6 — Misleading use of "ATA" for generic token accounts

- **Status:** New
- **Severity:** Informational
- **Creator:** Matías Barrios
- **Created:** Apr 29, 2026 at 20:19

Description
Account fields, variable names, comments, and error messages use the term "ATA" (Associated Token Account) when the accounts are typed as `InterfaceAccount<'info, TokenAccount>` — a generic token account that does not enforce ATA derivation. For example:

- `user_reward_ata` in both `Open` and `CloseAndSelectIntent` context structs is declared as `InterfaceAccount<'info, TokenAccount>`, not as an ATA-constrained account.
- `sweep_recipient_ata` in `CloseAndSelectIntent` is also a generic `TokenAccount`.
- Error messages reference "ATA" explicitly: `"User reward ATA owner does not match the user signer."`, `"sweep_recipient_ata must not belong to the program or the Portal."`.
While in practice the Solver constructs the transaction using canonical ATAs, the on-chain program accepts any token account that satisfies the owner and mint constraints. The naming creates a false expectation that ATA derivation is enforced.
Affected Assets

- `programs/eco-swap-gateway/src/instructions/open.rs`
- `programs/eco-swap-gateway/src/instructions/close_and_select_intent.rs`
- `programs/eco-swap-gateway/src/errors.rs`
Recommendation
Rename account fields and update comments/error messages to use "token account" instead of "ATA" for consistency with the actual type constraints. Reserve "ATA" for accounts where canonical derivation is explicitly verified (e.g., `vault_ata_k`, which is checked against `get_associated_token_address_with_program_id`).

# Finding #5 — No minimum retention floor allows malicious Solver to extract full `swapOutput` while delivering negligible `routeAmount`

- **Status:** New
- **Severity:** Low
- **Creator:** Rajeev
- **Created:** Apr 29, 2026 at 09:16

## Summary

Fee parameters are Solver-supplied with no onchain floor enforcing a minimum `routeAmount` relative to `swapOutput`. A malicious Solver can pass a near-zero retention fraction `feeNumerator / feeDenominator`, collecting full `swapOutput` as reward while delivering almost nothing to the user on the destination chain.

## Description

`routeAmount` is computed as `swapOutput * feeNumerator / feeDenominator - flatFee`, where `feeNumerator` and `feeDenominator` are used as retention parameters instead of fee parameters . Scalar validation only enforces `feeNumerator <= feeDenominator` and both nonzero. So a malicious Solver can pass, for example, `feeNumerator=1`, `feeDenominator=1000`, retaining 0.1% of `swapOutput` as `routeAmount` while collecting the full `swapOutput` as reward.
The user's documented defense is pre-signature inspection of the decoded route bytes, but in practice users rely on the Solver's quote UI rather than raw route bytes. The Solver has complete information asymmetry: they control the fee parameters, construct the route, present the quote UI, and are the sole entity who can fulfill the intent. There is no onchain check that `routeAmount` bears any reasonable relationship to `swapOutput`.

## Recommendation

Consider:

- Enforcing a minimum retention floor  so that `routeAmount` is within a protocol-enforced ratio of `swapOutput`.
- Changing the variable names of `feeNumerator` and `feeDenominator` to indicate them being retention parameters as implemented rather than fee parameters. Or change the logic if they are indeed fee parameters.

# Finding #4 — Asymmetry between rebasing `outputToken` on EVM and explicit denylist on SVM

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 29, 2026 at 08:41

## Summary

The SVM program explicitly rejects `InterestBearingConfig` mints to protect its balance-delta measurement. The EVM contract's Natspec only excludes fee-on-transfer tokens potentially allowing an asymmetry in the handling of rebasing tokens with the SVM side.

## Description

`_executeSwap(...`) measures swap output as `balanceAfter - balanceBefore`. If `outputToken` is a rebasing token, any balance adjustment during the swap window affects the measurement. A positive rebase inflates `swapOutput`, overstating the reward locked in the `PORTAL` vault and the `routeAmount` delivered to the user. A negative rebase between measurement and `PORTAL`'s `transferFrom` causes the transfer to overdraw the gateway's balance, reverting the transaction, where the user loses gas and any DEX slippage without creating the intent. The SVM program protects against this explicitly via its `require_safe_mint` denylist which rejects `InterestBearingConfig`. The EVM Natspec documents only fee-on-transfer tokens as unsupported. This results in an asymmetry between rebasing `outputToken` on EVM and explicit denylist on SVM.

## Recommendation

Consider adding rebasing tokens to the unsupported token documentation on the EVM side.

---

# Finding #3 — Solver trust assumptions in `swapAndSelectIntent` may be risky

- **Status:** New
- **Severity:** Low
- **Creator:** Rajeev
- **Created:** Apr 29, 2026 at 08:25

## Summary

The onchain logic of `swapAndSelectIntent` has trust assumptions on the Solver for critical aspects of the intent where the expectation is that the user verifies the Solver provided offchain information before signing, and that those are translated onchain honestly by the Solver.

## Description

The offchain-onchain trust assumptions on the Solver include:

- `buckets[k].routeHash` encodes delivery to the correct recipient
- Destination amount in route bytes is fairly correlated with `rewardAmount`
- Offchain fee math matches the route's embedded amount
- `baseReward.creator` is the user's address
- `baseReward.prover` is a legitimate proof verifier
The Solver does not call publish for any of the candidate bucket intents, neither before nor after the user signs. Routes are only stored in the Solver's database and so the Solver fulfills the intent itself. The gateway never sees the route bytes for any candidate bucket because each Bucket carries only a bytes32 `routeHash` and a `rewardAmount`. There is no onchain artifact to cross-check the hash against, and the gateway has no mechanism to verify that the route bytes are published, structurally valid, or encode a destination action the Solver can and will fulfill. As specified:

- "Fillership is structurally tied to the Solver that priced and bucketed the swap, not a permissionless third party as in normal Eco intents."
- "Trust placement. Route-bytes integrity is a Solver-side responsibility — only the Solver holds the bytes (keyed by routeHash in its own database), and only the Solver can fulfill. On-chain there is nothing to verify against. Deadline-based refund (Portal::refund) is the user's safety net if a wrong route is committed and never fulfilled."
- "The user inspects the decoded route from the Solver's quote payload prior to signing. No on-chain artifact exists at sign time to cross-check; refund-after-deadline is the safety net."
Therefore, for example, if the `routeHash` corresponds to different `route` bytes than were shared by the Solver, are incorrectly encoded accidentally/maliciously, or point to a destination action the Solver did not price and commit to, the vault is correctly capitalized but no other Solver can fill the intent. Capital is not permanently lost in the accidental scenarios but it remains locked in the vault until `reward.deadline`, at which point `IntentSource.refund()` returns it to `reward.creator`. Onchain validation of route bytes is architecturally not possible given the calldata budget constraints that motivate the hash-only bucket representation. Correctness of `routeHash` and publication of the corresponding `route` bytes is the responsibility of the user who trusts that Solver is not malicious.
These offchain-onchain trust assumptions on Solver's honesty are documented in the specification but is risky for the user.

## Recommendation

Consider:

- Implementing the documented attestation enhancement that is currently specified as out-of-scope: "Current model relies on the user's pre-signature inspection of the decoded route and the deadline-based refund as fallback. An on-chain signed attestation over the candidate routes would tighten the trust boundary if needed."
- Surfacing these trust assumptions of the Solver to users appropriately for additional due-diligence at a minimum.

# Finding #2 — Delegating slippage protection to `swapCalls` risks unexpected swap outputs

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 29, 2026 at 08:10

## Summary

`_executeSwap(...)` accepts any non-zero swap output with no onchain floor, leaving slippage protection entirely dependent on the caller encoding a minimum output parameter inside their `swapCalls` and risks unexpected swap outputs at the gateway level.

## Description

Output is measured as a balance delta and only required to be non-zero. If the caller includes a DEX router call with a minimum output parameter such as `amountOutMinimum`, the router enforces it. If the caller omits it or uses a DEX that does not natively support a minimum output parameter then the gateway accepts whatever non-zero amount the swap returns. A sandwiched transaction can therefore produce a validly funded intent at a significantly worse rate than the user expected, with no onchain recourse. There is no `minSwapOutput` parameter at the gateway level to act as a protocol-enforced backstop independent of DEX router capabilities. Correct slippage configuration is assumed to be the responsibility of the caller and the integration SDK.

## Recommendation

Ensure that correct slippage configuration being the responsibility of the caller and the integration SDK is well documented and highlighted.

---

# Finding #1 — Incorrect `calldataAmountOffset` produces funded but unfillable intent

- **Status:** New
- **Severity:** Informational
- **Creator:** Rajeev
- **Created:** Apr 29, 2026 at 07:49
- **Code:**
  - [evm/contracts/EcoSwapGateway.sol](https://cantina.xyz/code/1a093301-e0b1-42d6-ae85-71050f5b1dae/evm/contracts/EcoSwapGateway.sol#L307-L314)

## Summary

Setting `SKIP_CALLDATA_PATCH` on a route that requires two amount patch sites creates a valid funded intent whose destination calldata retains a zero placeholder, causing the intent to go unfulfilled until expiry.

## Description

Route bytes are opaque to `EcoSwapGateway`, which cannot determine whether a given route requires one or two amount patch sites without per-protocol decoders and so cannot validate that `calldataAmountOffset` is correctly specified. If `SKIP_CALLDATA_PATCH` is passed for a route that embeds the transfer amount in both its token list and its destination calldata, only the token list slot is patched and the calldata argument retains its template placeholder. The funded intent is structurally valid and the vault is correctly capitalized, but the destination execution attempts the wrong amount and the intent goes unfulfilled. Capital is not permanently lost but it remains locked in the vault until `reward.deadline`, at which point `IntentSource.refund()` returns it to `reward.creator`. Correct offset configuration is the responsibility of the caller and the integration SDK.

## Recommendation

Ensure that correct offset configuration being the responsibility of the caller and the integration SDK is well documented and highlighted.
