# EcoSwapGateway — Bucketed Design (EVM + SVM)

Implementation of the atomic "swap + create intent" helper used for Eco
Protocol cross-chain transfers originating on either EVM or SVM when the
source token is non-standard.

Related: [Cross-Chain Swap Cases spec](https://www.notion.so/eco-corp/Cross-Chain-Swap-Cases-342805b0f17f81d786eac2d41520b113).

## Problem

The reward amount an intent carries is the swap's actual output — unknown
until after the DEX swap executes. On EVM source this is fine: the helper
measures balance delta at runtime and calls `Portal.publishAndFund` with
the exact amount. On SVM source it's not: the vault PDA must be declared
in the transaction accounts before execution, and
`vault_pda = PDA(["vault", intent_hash])` where `intent_hash` incorporates
the reward amount (`eco-routes-svm/programs/portal/src/types.rs:206`).
Runtime-derived vault addresses are incompatible with Solana's account model.

Separately, when the destination carries a DEX swap (Case 3 — any-to-any),
the route calldata embeds the destination input amount. The Solver must
bake it in pre-swap; using the pessimistic `toMinAmount` leaves excess
tokens on destination that the destination DEX swap doesn't consume.

The bucketed design solves both problems with one mechanism.

## Approach

The off-chain Solver pre-computes **N candidate intents** anchored at
`[amountOutMinimum, quote]` — `bucket[0] = amountOutMinimum` (what the DEX
guarantees under the user's slippage tolerance), `bucket[N-1] = quote`
(the live DEX quote) — and hands the list to the user's wallet.

The user signs **one tx** that swaps, floor-selects bucket `k` based on the
actual swap output, and calls `Portal::fund(destination, routeHash_k,
reward_k)`. Portal's `fund` does not require prior publication on either
chain (see "Portal semantics" below). After the tx lands, the Solver reads
the `IntentSelected` event and calls `Portal::publish` for **only the
winning route**. Fillers index that single `IntentPublished` and proceed.

Anchoring buckets to `[amountOutMinimum, quote]` bounds worst-case surplus
by the slippage tolerance rather than a magic ±band: every successful swap
clears `bucket[0]`, and a quote-hit lands on `bucket[N-1]`.

- **Floor selection:** `k = max { i : reward_amount_i ≤ delta }`. If
  `delta > reward_amount_{N-1}`, cap at `k = N-1`.
- **`allowPartial = true`** on the fund call. If a third party front-ran
  the user and fully funded the selected vault, Portal's fund becomes a
  no-op (transfers 0) instead of reverting — the user's swap output is
  then swept to `sweepRecipient` rather than stranded.
- **Surplus sweep:** `delta − reward_amount_k` is transferred to
  `sweepRecipient`. Defaults to `msg.sender` / tx signer when the caller
  passes the zero address.
- **Same salt** across all N buckets. Hash uniqueness comes from varying
  `tokens[0].amount` in both the Route and the Reward.
- **Buckets carry `routeHash`, not route bytes.** The helper never
  reconstructs route bytes — it just passes `routeHash_k` to `Portal::fund`.
- **User is the funder.** The reward stablecoin sits in the user's ATA
  (EVM: `msg.sender`; SVM: user's reward-mint ATA) between swap completion
  and fund. No program custody account is needed. On SVM this is required
  by Portal's CPI model (`CpiContext::new` in `fund_context.rs` doesn't
  propagate signer seeds, so the `funder: Signer` must be a real tx signer,
  not a PDA).

## Portal semantics the design leans on

The post-publish flip above rests on two facts verified against
`eco-routes-svm @ 872c621`. Confirm on each revision before rolling the
commit pin forward.

- **`Portal::fund` does not require prior publication.** The only
  intent-related validation in `fund_intent` is
  `vault.key() == vault_pda(intent_hash)` (`fund.rs:49-52`) — a
  deterministic address check. There is no `PublishedMarker` PDA, no
  published-flag lookup; `publish_intent` is pure event emission
  (`publish.rs:17-42`: `pub struct Publish {}` is an empty accounts struct
  and the handler only calls `emit!`). Funding an unpublished vault is
  legal and structurally indistinguishable from funding a published one.
- **`route_hash` is a flat `keccak(borsh(Route))`** (`types.rs:229-239`),
  structurally identical to the EVM `keccak(abi.encode(Route))` primitive.
  Account metas for SVM destinations travel *inside* `Call.data` as a
  serialized `CalldataWithAccounts` (`types.rs:183-187`) — there is no
  separate `accounts` vec on `Route`, so the commitment primitive is a
  single flat hash and matches EVM's shape. Fulfill-side reconstruction is
  Portal's problem, not the source-chain commitment's.

If either fact changes upstream (Portal adds a `PublishedMarker`, or the
commitment primitive gains a non-hash field), re-derive F2: a
publication prerequisite forces pre-publish and reopens "N publishes per
quote"; a non-hash commitment forces a different bucket representation.

## EVM interface — two functions

Located at `evm/contracts/EcoSwapGateway.sol`.

### `swapAndCreateIntent` (simplified, existing)

Simple path: swap any token to a stablecoin, create a single cross-chain
intent whose destination action is a plain ERC20 transfer.

Changes from the current implementation:
- Remove `rewardAmount` param. Reward always equals full `swapOutput`.
- Remove `routeTemplate`, `tokensAmountOffset`, `calldataAmountOffset`.
  Helper builds `transfer(recipient, route_amount)` internally.
- `destinationRecipient` as `bytes32` (supports EVM address and SVM pubkey).
  Dispatch on `routeType`: EVM path takes low 20 bytes as `address`; SVM
  path uses the full 32 bytes as a pubkey.
- `route_amount = swapOutput * feeNumerator/feeDenominator − flatFee`
  with source/destination decimal adjustment — unchanged formula.
- Still calls `Portal.publishAndFund(destination, route, reward, allowPartial)`.

Signature sketch:

```solidity
struct CreateIntentParams {
    uint64 destination;
    address destinationToken;          // reward token on destination chain
    bytes32 destinationRecipient;      // EVM address (low 20) or SVM pubkey
    uint64 rewardDeadline;
    address rewardCreator;
    address rewardProver;
    uint256 flatFee;
    uint256 feeNumerator;
    uint256 feeDenominator;
    uint8 sourceDecimals;
    uint8 destinationDecimals;
    bool allowPartial;
    RouteType routeType;
}

function swapAndCreateIntent(
    address inputToken,
    uint256 inputAmount,
    address outputToken,
    Call[] calldata swapCalls,
    CreateIntentParams calldata intent,
    address sweepRecipient                // address(0) = msg.sender
) external payable returns (bytes32 intentHash);
```

### `swapAndSelectIntent` (new, bucketed)

Bucketed path: swap, floor-select from N candidate intents, fund the match.
Publication of the winning route happens post-tx (Solver reads
`IntentSelected` and calls `Portal::publish` for bucket `k` only).

```solidity
struct Bucket {
    bytes32 routeHash;
    uint256 rewardAmount;
}

function swapAndSelectIntent(
    address inputToken,
    uint256 inputAmount,
    address outputToken,               // reward token (stablecoin on source)
    Call[] calldata swapCalls,
    uint64 destination,
    Reward calldata baseReward,        // tokens[0] = (outputToken, 0); nativeAmount = 0
    Bucket[] calldata buckets,         // strictly ascending by rewardAmount
    address sweepRecipient             // address(0) = msg.sender
) external nonReentrant returns (bytes32 intentHash);
```

Flow:
1. Validate inputs (see "EVM invariants" below).
2. Pull `inputAmount` from caller, execute `swapCalls`, measure
   `swapOutput = balanceAfter − balanceBefore` on `outputToken`.
3. Require `swapOutput ≥ buckets[0].rewardAmount`.
4. Scan `buckets` (single pass) validating ascending and computing
   `k = max { i : buckets[i].rewardAmount ≤ swapOutput }`; cap at `N-1`.
5. Build `reward_k` in memory by cloning `baseReward` and setting
   `reward_k.tokens[0].amount = buckets[k].rewardAmount`. Dynamic arrays
   can't be mutated on calldata-typed structs — the clone is mandatory.
6. `IERC20(outputToken).forceApprove(PORTAL, buckets[k].rewardAmount)`.
7. `intentHash = PORTAL.fund(destination, buckets[k].routeHash, reward_k, true)`.
   `allowPartial=true` so a front-run by a third-party funder becomes a no-op.
8. `IERC20(outputToken).forceApprove(PORTAL, 0)`. Reset approvals for
   every `swapCalls[i].target` as well.
9. Sweep residual `inputToken`, residual `outputToken`, and ETH to
   `sweepRecipient` (defaulting to `msg.sender` if zero).
10. Emit `IntentSelected(intentHash, msg.sender, swapOutput, k, buckets[k].rewardAmount)`.

#### EVM invariants (checked on-chain in `swapAndSelectIntent`)

| Invariant | Purpose |
|---|---|
| `buckets.length > 0` | Prevent empty selection |
| `buckets[i].rewardAmount > buckets[i-1].rewardAmount` (single pass, folded into the selection loop) | Floor selection requires strict ordering |
| `baseReward.tokens.length == 1` | Single-token reward; v1 scope |
| `baseReward.tokens[0].token == outputToken` | Reward token must match swap output |
| `baseReward.tokens[0].amount == 0` | Amount slot must be the clone-and-set placeholder |
| `baseReward.nativeAmount == 0` | Native rewards out of scope for v1 |
| `baseReward.creator != address(0)` | Mirrors existing `InvalidRewardCreator` guard |
| `baseReward.prover != address(0)` | Mirrors existing `InvalidRewardProver` guard |
| `sweepRecipient != address(this)` and `!= address(PORTAL)` | Prevent funds trapped in contracts |
| `swapOutput >= buckets[0].rewardAmount` | Enforces the Solver's min-output claim |

#### Events

- `IntentCreated(bytes32 indexed intentHash, address indexed user, uint256 swapOutput)` — emitted by Function 1.
- `IntentSelected(bytes32 indexed intentHash, address indexed user, uint256 swapOutput, uint256 bucketIndex, uint256 rewardAmount)` — emitted by Function 2.
- `Portal.IntentFunded(intentHash, funder, complete)` is emitted by the Portal inside `fund`. Fillers index this.

## SVM interface — one program, two instructions

New Anchor program at `svm/programs/eco-swap-gateway/`.

### `open`

Snapshots the user's reward-mint ATA balance into a short-lived PDA so
`close_and_select_intent` can compute the swap delta.

Accounts:
- `user: Signer(mut)` — pays snapshot rent
- `user_reward_ata: TokenAccount` — user's ATA for the reward mint (the
  token Jupiter delivers post-swap)
- `snapshot: PDA(init, seeds = ["snap", user_reward_ata])` — deterministic
  seed by the ATA pubkey (unique per user+mint); no nonce needed
- `system_program`

Writes `snapshot.pre_balance = user_reward_ata.amount`.

### `close_and_select_intent`

Measures delta, picks bucket `k`, CPIs `Portal::fund` for bucket `k` only,
then sweeps surplus.

Accounts (static):
- `user: Signer(mut)` — funder, payer, snapshot close-rent recipient
- `user_reward_ata: TokenAccount(mut)` — source of the reward tokens (re-checked for owner == user and mint == reward mint)
- `snapshot: PDA(close = user, seeds = ["snap", user_reward_ata])` — Anchor refunds rent on close
- `sweep_recipient_ata: TokenAccount(mut)` — where `delta − reward_amount_k` lands (must be pre-initialized)
- `mint: InterfaceAccount<Mint>` — reward token mint; SPL Token or Token-2022. If Token-2022, mint extensions are checked against an allow-list (see "Mint safety" below).
- `portal_program: Program` — compile-time-pinned ID `Ecoo5HDM2XCBy7QzkhDGrAmnRcWw7emU6xGr7CcCmooo`
- `token_program: Program<Token>`, `token_2022_program: Program<Token2022>`, `associated_token_program`, `system_program`

Accounts (remaining, outer ix, ordered by `k ∈ [0, N)`):
- For each k: `vault_pda_k` (writable), `vault_ata_k` (writable).
- These are declared to give the runtime permission to write to the
  selected bucket's pair. The CPI only forwards `(user_reward_ata,
  vault_ata_k, mint)` as Portal's `remaining_accounts` — Portal chunks
  them in groups of 3 per reward token (`types.rs:13` —
  `VEC_TOKEN_TRANSFER_ACCOUNTS_CHUNK_SIZE = 3`).

Args:

```rust
pub struct Bucket {
    pub route_hash: [u8; 32],
    pub reward_amount: u64,
}

pub struct CloseAndSelectArgs {
    pub destination: u64,
    pub base_reward: Reward,        // tokens[0].amount = 0 placeholder
    pub buckets: Vec<Bucket>,       // strictly ascending by reward_amount
}
```

Flow:
1. Re-verify `user_reward_ata.owner == user.key()` and `user_reward_ata.mint == base_reward.tokens[0].token` (Jupiter-ix tampering guard).
2. `delta = user_reward_ata.amount.checked_sub(snapshot.pre_balance)?`.
3. Validate `buckets` non-empty, strictly ascending, and `delta >= buckets[0].reward_amount`.
4. Validate `mint.key() == base_reward.tokens[0].token`, `base_reward.deadline > clock.unix_timestamp`, and call `require_safe_mint(mint)` (see "Mint safety").
5. `k = partition_point(buckets, |b| b.reward_amount <= delta) − 1`; cap at `N−1`.
6. Construct `reward_k` by cloning `base_reward` and setting `reward_k.tokens[0].amount = buckets[k].reward_amount`.
7. CPI `Portal::fund` with:
   - Accounts: `payer = user, funder = user, vault = vault_pda_k, token_program, token_2022_program, associated_token_program, system_program`. Both token programs are forwarded; Portal dispatches internally based on `mint.owner` (`fund.rs:31-33`).
   - `remaining_accounts` to the CPI: `[user_reward_ata, vault_ata_k, mint]` — exactly one `(from, to, mint)` triple for our single reward token.
   - `FundArgs { destination, route_hash: buckets[k].route_hash, reward: reward_k, allow_partial: true }`.
   Portal internally derives `intent_hash`, validates the vault address, creates the vault ATA via `create_associated_token_account` if empty (`fund_context.rs:111-126`), and emits `IntentFunded`. `allow_partial=true` makes a front-run a no-op.
8. Transfer `delta − buckets[k].reward_amount` from `user_reward_ata` to
   `sweep_recipient_ata` via `token_interface::transfer_checked`, with `user` as authority. The token program used is selected from `mint.owner` so the same helper works for both SPL Token and Token-2022 mints.
9. Emit `IntentSelected { intent_hash, user, delta, bucket_index: k, reward_amount: buckets[k].reward_amount }`.
10. `snapshot` closes (Anchor's `close = user` handles the rent refund).

### Mint safety (`require_safe_mint`)

SPL Token mints are accepted unconditionally. Token-2022 mints are accepted if and only if none of the following extensions are present on the mint:

| Extension | Why it's rejected |
|---|---|
| `TransferFeeConfig` | Transfer debits a fee; actual credited amount differs from the transferred amount. Breaks delta math and under-funds the vault. |
| `TransferHook` | Transfers invoke a user-chosen program that needs accounts not declared in our tx. CPI would fail or be exploitable. |
| `InterestBearingConfig` | Balance accrues between `open` and `close`; delta includes interest income, not just swap output. |
| `PermanentDelegate` | A third party can move tokens out of the ATA between `open` and `close`, invalidating the snapshot. |
| `ConfidentialTransferMint` | Balances are encrypted; `user_reward_ata.amount` is unreadable for delta math. |
| `NonTransferable` | Transfer reverts; intent can never be funded. |
| `DefaultAccountState` | When the default is `Frozen`, ATA transfers are disabled. Rejecting the extension outright (regardless of default value) keeps the check simple. |

Benign extensions (`MetadataPointer`, `Metadata`, `MintCloseAuthority`, `GroupPointer`, `Group`, `MemberPointer`, `Member`, `MemoTransfer`) pass the check.

Implementation: unpack the mint data via `StateWithExtensions::<token_2022::Mint>::unpack(&mint_data)` and iterate `get_extension_types()?`. Rejection is a single `require!` per rejected extension type. The TLV walk is O(mint extension count), ~500 CU in practice.

## Solver responsibilities (off-chain)

Per quote:

1. Fetch Jupiter/DEX quote. Derive `N` from config keyed by `(sourceMint, destToken)`. N ≤ 14 on SVM for v1. Record `quote` (best expected output) and `amountOutMinimum = quote × (1 − slippage_bps / 10_000)`.
2. Compute `buckets[k]` for `k ∈ [0, N)`:
   - `reward_amount_0 = amountOutMinimum`; `reward_amount_{N-1} = quote`; intermediates linearly spaced: `reward_amount_k = amountOutMinimum + k × (quote − amountOutMinimum) / (N − 1)`.
   - `route_amount_k = reward_amount_k × feeNum / feeDen − flatFee` with source/destination decimal scaling. Fee model is shared with F1 (6 bps scalar + \$0.01 flat). Any drift between off-chain and on-chain fee computation silently corrupts `routeHash_k` and only surfaces at fulfillment — keep the formulas byte-identical.
3. Construct full `Route` bytes per bucket with `tokens[0].amount = route_amount_k` and route calls encoded with that same amount. Salt is shared across all buckets.
4. Compute `route_hash_k = keccak(route_k)`, `vault_pda_k = PDA(["vault", intent_hash_k])`, `vault_ata_k = ATA(vault_pda_k, mint)`. **No publish calls yet.**
5. Build the user's tx:
   - **SVM:** create per-quote ALT holding all 2N bucket accounts, wait for activation, build a v0 tx with `[SetComputeUnitLimit(400_000), open, <Jupiter ixs>, close_and_select_intent]`.
   - **EVM:** encode the `swapAndSelectIntent` calldata with `buckets[]`.
6. Render the decoded `Route` for each bucket in the UI (destination contract/program, target, decoded calldata, amounts). The user signs trusting this rendering — there's nothing indexed on-chain yet to cross-check against.
7. User signs; tx is broadcast.
8. **Post-tx:** subscribe to (or poll for) the `IntentSelected` event from the user's tx. Extract `intent_hash`, `bucket_index`, `route_k` (from the Solver's local cache keyed by `route_hash_k`). Call `Portal::publish(destination, route_k, reward_k)` once. Fillers index the resulting `IntentPublished` and fulfill. If the Solver skips this step, the funded intent is never discovered by fillers and the user's reward refunds automatically after `reward.deadline`.

## Account budget (SVM)

Per v0 tx with per-quote ALT:

- Static writable: `user`, `user_reward_ata`, `sweep_recipient_ata`, `snapshot` = 4
- Per-bucket writable: `vault_pda_k` + `vault_ata_k` = **2N**
- Shared readonly: mint, Portal program, SPL programs, our program ≈ 6

**N cap driven by instruction-data size, not writable-account count.** Each `Bucket` is 40 bytes (32 + 8); `base_reward` ≈ 100 bytes; Anchor overhead + `destination` ≈ 18 bytes. At N=14, ix data ≈ 678 bytes, safely below the 1232-byte packet limit when combined with ComputeBudget + open + Jupiter ixs. Practical ceiling: **N ≤ 14**. If `Reward` or other Solver-chosen fields grow, re-budget.

Writable-account ceiling (`4 + 2N`) is 32 at N=14 — well under Solana's v0-with-ALT caps (64 writable / 128 total loaded).

## Compute budget (SVM)

`close_and_select_intent` cost breakdown:

- Bucket ascending-validation + floor selection: O(N), ~2–3k CU.
- Borsh-clone `Reward`, set `tokens[0].amount`: ~3–5k CU.
- `require_safe_mint` TLV walk (Token-2022 only; SPL Token early-returns): ~500 CU.
- CPI `Portal::fund`:
  - Borsh-serialize + keccak `reward_k` (~5k), keccak `intent_hash` (~1k).
  - `find_program_address` for vault PDA inside Portal (`state.rs:13`): ~20k CU (dominant hidden cost).
  - `TransferChecked` CPI: ~5k.
  - Optional `create_associated_token_account` for first-time vault ATA: ~20k.
- `transfer_checked` for sweep: ~5k.
- Misc: account re-checks, event emission: ~3k.

Total worst-case (with vault ATA creation): ~70–85k CU. Budget `SetComputeUnitLimit(200_000)` gives comfortable headroom; `400_000` as the initial default provides further margin for Jupiter variance.

## Trust boundaries

| Input | Source | Validation |
|---|---|---|
| `buckets` strictly ascending by reward_amount | Solver | **Checked on-chain** |
| `buckets.length > 0`, `delta ≥ buckets[0]` | Solver + swap | **Checked on-chain** |
| `base_reward.tokens` shape (length=1, token=reward mint, amount=0) | Solver | **Checked on-chain** |
| `base_reward.nativeAmount == 0` | Solver | **Checked on-chain** (v1 scope) |
| `base_reward.deadline > now`, creator/prover ≠ 0 | Solver | **Checked on-chain** |
| `sweepRecipient != self, != PORTAL` | Caller | **Checked on-chain** |
| `mint` has no unsafe Token-2022 extensions | Solver (via mint choice) | **Checked on-chain** via `require_safe_mint` (see "Mint safety") |
| `route_hash_k` corresponds to a real route the Solver will publish | Solver | **Not checked on-chain.** No indexed event exists pre-signing under the post-publish model — UI renders decoded `Route` bytes and user trusts. Post-tx, if the Solver fails to publish (or publishes bytes hashing to a different `intent_hash`), fillers never index the funded vault and the reward refunds after `reward.deadline`. Solver is incentive-aligned: only publishing the winning route produces a fill-and-paid outcome. |
| `route_amount_k = f(reward_amount_k)` (formula honesty) | Solver | **Not checked on-chain.** Route bytes are never reconstructed in the helper. UI must render the decoded route on the quote for user review. Off-chain and on-chain fee math must match byte-for-byte; drift silently corrupts `routeHash_k` and only surfaces at fulfillment. |
| `base_reward.creator, prover, deadline` | Solver | **Not checked for correctness** beyond non-zero and non-expired. User-level trust. |
| `vault_pda_k` matches `intent_hash_k` | Tx construction | **Checked on-chain** by Portal (`fund.rs:49-52`). Mismatch reverts. |
| Salt (inside route, same across buckets) | Solver | Not checked; hash uniqueness flows from amount varying |

The front-end / wallet is a trust-critical component for the two "Not checked on-chain" rows above. Documenting the UI's responsibilities — Route rendering, post-publish monitoring for the expected `IntentPublished` event, refund-claim path if publish never happens — is part of the Solver-side integration (out of scope for this repo but listed here so the contract surface is clear).

## Known limitations

- **Quantization loss.** Outputs between `reward_amount_k` and `reward_amount_{k+1}` round down to bucket `k`; surplus goes to `sweepRecipient`, so no value is destroyed. Narrower buckets (larger N) reduce loss at the cost of larger ix data and more bucket accounts on SVM.
- **Per-quote ALT on SVM** adds ~1 slot of latency between quote and send.
- **N ≤ 14 on SVM** from ix-data size. EVM has no equivalent cap.
- **Front-run funding** can race the user once the tx is gossiped (third party calls `Portal.fund` with the same `routeHash` before the user's tx confirms). `allowPartial=true` makes this a no-op for the user; user's swap output goes to `sweepRecipient` instead of the vault. Less practical on Solana (no public mempool) than EVM, but cheap insurance.
- **Solver route-honesty is a trust assumption.** UI rendering of the decoded route is the pre-signing defence; the deadline-based refund path is the post-tx defence if the Solver never publishes or publishes wrong bytes. Neither is checked on-chain at fund time.
- **Post-publish is a Solver SLA, not a contract guarantee.** If the Solver fails to publish the winning route after the user tx lands, fillers never see the funded intent and the user's funds sit until `reward.deadline`, then `Portal::refund` returns them. No funds are destroyed, but the user pays tx fees and is waiting on a refund window. Monitoring + alerting on orphaned `IntentFunded`-without-`IntentPublished` pairs is part of Solver ops.

## Out of scope (v1)

- Native SOL / ETH rewards. Portal supports them; add a `nativeAmount` field on `Bucket` when needed.
- Token-2022 mints carrying any of the extensions listed in "Mint safety" (TransferFee, TransferHook, InterestBearing, PermanentDelegate, ConfidentialTransfer, NonTransferable, DefaultAccountState). Benign Token-2022 mints (Metadata, MemoTransfer, etc.) are supported.
- Multiple reward tokens per intent.
- Split Jupiter / multi-tx routes.
- Admin/pause switch. Neither the existing `EcoSwapGateway.sol` nor this revision includes one; evaluate once live volume exists.
- Solver attestation signatures. Current model relies on UI rendering of the decoded route + post-tx monitoring of the expected `IntentPublished` event; an on-chain signed attestation over `route_k` per bucket is the next step if we want on-chain accountability.

## Open questions

- **ALT lifecycle.** Per-quote creation in v1, closed after use or aged out. Evaluate a shared long-lived ALT per asset pair if quote-to-send latency becomes material.
- **Bucket spacing.** Linear between `amountOutMinimum` and `quote` for v1. Empirical swap outputs under healthy market conditions cluster near the top of the range (near the quote); under adverse conditions they cluster near the bottom. Revisit with non-linear (log or quantile-based) spacing per pair once we have real-world distribution data.
