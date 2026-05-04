// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Call, Reward} from "eco-routes/contracts/types/Intent.sol";

/// @notice Route encoding format for the destination chain.
enum RouteType {
    EVM,
    SVM
}

/// @notice Parameters for creating an intent from a swap output.
/// @dev Fee parameters (retentionNumerator, retentionDenominator, flatFee) are caller-controlled
///      by design — this contract does not enforce protocol fees.
struct IntentParams {
    uint64 destination;
    bytes routeTemplate;
    uint32 tokensAmountOffset;
    uint32 calldataAmountOffset;
    uint64 rewardDeadline;
    address rewardCreator;
    address rewardProver;
    uint256 flatFee;
    uint256 retentionNumerator;
    uint256 retentionDenominator;
    uint8 sourceDecimals;
    uint8 destinationDecimals;
    bool allowPartial;
    RouteType routeType;
}

/// @notice A candidate intent the helper can fund by selecting it based on
///         actual swap output. `routeHash` is the hash of a Route the caller
///         has committed to off-chain; `rewardAmount` is the stablecoin amount
///         this bucket locks as reward on source.
/// @dev Portal.fund derives the vault deterministically from
///      (destination, routeHash, reward) and does not require the intent to
///      have been previously published. Publishing is a solver-side concern
///      (it makes the full Route bytes indexable via IntentPublished events),
///      not a precondition for the gateway.
struct Bucket {
    bytes32 routeHash;
    uint256 rewardAmount;
}

interface IEcoSwapGateway {
    // --- Events ---

    event IntentCreated(bytes32 indexed intentHash, address indexed user, uint256 swapOutput);

    event IntentSelected(
        bytes32 indexed intentHash,
        address indexed user,
        uint256 swapOutput,
        uint256 bucketIndex,
        uint256 rewardAmount,
        bytes32 bucketsHash
    );

    // --- Errors ---

    error InsufficientSwapOutput();
    error InvalidInputAmount();
    error InvalidScalar();
    error RouteAmountZero();
    error OffsetOutOfBounds();
    error CallFailed(uint256 index, bytes reason);
    error InvalidPortal();
    error InvalidSweepRecipient();
    error InvalidRewardCreator();
    error InvalidRewardProver();
    error NativeTransferFailed();
    error AmountOverflowU64();
    error EmptyBuckets();
    error BucketsNotAscending();
    error SwapOutputBelowMinBucket();

    // Base-reward validation — split so integrators see which field failed.
    error RewardNativeAmountNotZero();
    error RewardMustHaveOneToken();
    error RewardMustHaveNoTokens();
    error RewardTokenMismatch();
    error RewardPlaceholderAmountNotZero();

    // --- Core ---

    /// @notice Executes swap calls, measures the output delta, patches the
    ///         caller-supplied route template with the computed route amount,
    ///         and creates + funds an intent via `Portal.publishAndFund`.
    /// @dev Reward equals the full `swapOutput` (balance delta on `outputToken`).
    ///      Does not support fee-on-transfer tokens as `outputToken`. Callers
    ///      must include token approval calls (e.g., `inputToken.approve(dex, amount)`)
    ///      in `swapCalls` — the contract does not pre-approve any targets.
    ///      Post-swap cleanup sweeps residual token and ETH balances but does
    ///      NOT revoke any `inputToken` allowances granted to `swapCalls[i].target`.
    ///      Callers leaving non-zero residual allowances (e.g. `type(uint256).max`
    ///      or any over-approval) SHOULD append an explicit
    ///      `inputToken.forceApprove(target, 0)` entry to `swapCalls` after the
    ///      swap that consumes the approval, otherwise the gateway holds open
    ///      attack surface against any subsequent `safeTransferFrom` pull.
    ///      Supports both EVM and SVM destination routes via `RouteType`.
    /// @dev WARNING: `swapCalls` are caller-supplied and arbitrary; the only on-chain
    ///      enforcement is `swapOutput > 0`. Callers and SDKs must inspect every target
    ///      and selector before signing — blind-signing this payload is unsafe.
    /// @param inputToken      ERC20 token to pull from the caller, or `address(0)`
    ///                        to signal native ETH input (amount is `msg.value`).
    /// @param inputAmount     Amount of inputToken to pull. Must be > 0 for ERC20
    ///                        input; ignored when `inputToken == address(0)`.
    /// @param outputToken     ERC20 token expected from the swap (reward token),
    ///                        or `address(0)` to signal a native ETH reward
    ///                        (measured via `address(this).balance` delta).
    /// @param swapCalls       Arbitrary calls for swap execution (approve, swap, etc.).
    /// @param intent          Intent creation parameters (including route template + offsets).
    /// @param sweepRecipient  Address to receive residual tokens and ETH.
    ///                        Pass `address(0)` to default to `msg.sender`.
    /// @return intentHash     Hash of the created intent.
    function swapAndCreateIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata swapCalls,
        IntentParams calldata intent,
        address sweepRecipient
    ) external payable returns (bytes32 intentHash);

    /// @notice Executes swap calls, measures the output delta, floor-selects a
    ///         bucket whose `rewardAmount <= swapOutput`, and funds it via
    ///         `Portal.fund` with `allowPartial=true` (so a front-run funding
    ///         becomes a no-op).
    /// @dev Funding is deterministic in `(destination, routeHash, reward)` —
    ///      the bucket's intent does *not* need to be published beforehand.
    ///      Solvers typically observe `IntentSelected` (or pre-publish candidate
    ///      routes) to discover the full Route bytes needed for fulfillment.
    ///      Surplus (`swapOutput - buckets[k].rewardAmount`) is swept to
    ///      `sweepRecipient`.
    ///      Bucket structural invariants are validated *before* the swap so a
    ///      malformed array fails fast and the user does not eat DEX slippage.
    ///      The `swapOutput >= floor0` check is post-swap (it depends on output).
    ///      On-chain invariants:
    ///        - buckets non-empty                            → EmptyBuckets
    ///        - strictly ascending by `rewardAmount`         → BucketsNotAscending
    ///        - `swapOutput >= buckets[0].rewardAmount`      → SwapOutputBelowMinBucket
    ///        - `baseReward.creator != 0`                    → InvalidRewardCreator
    ///        - `baseReward.prover != 0`                     → InvalidRewardProver
    ///        - sweepRecipient not self, not Portal          → InvalidSweepRecipient
    ///      ERC20 reward (outputToken != 0):
    ///        - `baseReward.nativeAmount == 0`               → RewardNativeAmountNotZero
    ///        - `baseReward.tokens.length == 1`              → RewardMustHaveOneToken
    ///        - `baseReward.tokens[0].token == outputToken`  → RewardTokenMismatch
    ///        - `baseReward.tokens[0].amount == 0`           → RewardPlaceholderAmountNotZero
    ///      Native reward (outputToken == 0):
    ///        - `baseReward.tokens.length == 0`              → RewardMustHaveNoTokens
    ///        - `baseReward.nativeAmount == 0`               → RewardPlaceholderAmountNotZero
    ///      Residual-allowance behaviour: cleanup sweeps balances but does NOT
    ///      revoke `inputToken` allowances granted by `swapCalls` to each
    ///      `swapCalls[i].target`. Callers SHOULD append an explicit
    ///      `inputToken.forceApprove(target, 0)` entry to `swapCalls` whenever
    ///      a non-zero residual would otherwise persist past the swap.
    /// @dev WARNING: `swapCalls` are caller-supplied and arbitrary; the only on-chain
    ///      enforcement is `swapOutput > 0`. Callers and SDKs must inspect every target
    ///      and selector before signing — blind-signing this payload is unsafe.
    /// @param inputToken      ERC20 token to pull from the caller, or `address(0)`
    ///                        to signal native ETH input (amount is `msg.value`).
    /// @param inputAmount     Amount of inputToken to pull. Must be > 0 for ERC20
    ///                        input; ignored when `inputToken == address(0)`.
    /// @param outputToken     ERC20 token expected from the swap (reward token),
    ///                        or `address(0)` to signal a native ETH reward
    ///                        (measured via `address(this).balance` delta).
    /// @param swapCalls       Arbitrary swap calls.
    /// @param destination     Destination chain ID.
    /// @param baseReward      Reward template. For ERC20 rewards the placeholder
    ///                        is `tokens[0].amount` (with `tokens.length == 1`);
    ///                        for native rewards (`outputToken == address(0)`)
    ///                        the placeholder is `nativeAmount` (with an empty
    ///                        `tokens` array). The helper overwrites it with the
    ///                        selected bucket's amount.
    /// @param buckets         Pre-published intent candidates, strictly ascending.
    /// @param sweepRecipient  Address to receive residual input/output tokens, surplus, and ETH.
    ///                        Pass `address(0)` to default to `msg.sender`.
    /// @return intentHash     Hash of the funded intent.
    function swapAndSelectIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata swapCalls,
        uint64 destination,
        Reward calldata baseReward,
        Bucket[] calldata buckets,
        address sweepRecipient
    ) external payable returns (bytes32 intentHash);
}
