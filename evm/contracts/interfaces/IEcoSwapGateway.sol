// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Call, Reward} from "eco-routes/contracts/types/Intent.sol";

/// @notice Route encoding format for the destination chain.
enum RouteType {
    EVM,
    SVM
}

/// @notice Parameters for creating an intent from a swap output.
/// @dev Fee parameters (feeNumerator, feeDenominator, flatFee) are caller-controlled
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
    uint256 feeNumerator;
    uint256 feeDenominator;
    uint8 sourceDecimals;
    uint8 destinationDecimals;
    bool allowPartial;
    RouteType routeType;
}

/// @notice A pre-published intent variant the helper can fund by selecting it
///         based on actual swap output. `routeHash` must identify an intent the
///         Solver already published via `Portal::publish`; `rewardAmount` is the
///         stablecoin amount this bucket promises to lock as reward on source.
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
    error InvalidCallTarget(address target);
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
    ///      Supports both EVM and SVM destination routes via `RouteType`.
    /// @param inputToken      ERC20 token to pull from the caller.
    /// @param inputAmount     Amount of inputToken to pull (must be > 0).
    /// @param outputToken     ERC20 token expected from the swap (reward token).
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
    ///         pre-published bucket, and funds it via `Portal.fund` with
    ///         `allowPartial=true` (so a front-run funding becomes a no-op).
    /// @dev The Solver must have already called `Portal.publish` for each
    ///      bucket's `routeHash` before the user signs this tx. Surplus
    ///      (`swapOutput - buckets[k].rewardAmount`) is swept to `sweepRecipient`.
    ///      Bucket structural invariants are validated *before* the swap so a
    ///      malformed array fails fast and the user does not eat DEX slippage.
    ///      The `swapOutput >= floor0` check is post-swap (it depends on output).
    ///      On-chain invariants:
    ///        - buckets non-empty                            → EmptyBuckets
    ///        - strictly ascending by `rewardAmount`         → BucketsNotAscending
    ///        - `swapOutput >= buckets[0].rewardAmount`      → SwapOutputBelowMinBucket
    ///        - `baseReward.nativeAmount == 0`               → RewardNativeAmountNotZero
    ///        - `baseReward.tokens.length == 1`              → RewardMustHaveOneToken
    ///        - `baseReward.tokens[0].token == outputToken`  → RewardTokenMismatch
    ///        - `baseReward.tokens[0].amount == 0`           → RewardPlaceholderAmountNotZero
    ///        - `baseReward.creator != 0`                    → InvalidRewardCreator
    ///        - `baseReward.prover != 0`                     → InvalidRewardProver
    ///        - sweepRecipient not self, not Portal          → InvalidSweepRecipient
    /// @param inputToken      ERC20 token to pull from the caller.
    /// @param inputAmount     Amount of inputToken to pull (must be > 0).
    /// @param outputToken     ERC20 token expected from the swap (reward token).
    /// @param swapCalls       Arbitrary swap calls.
    /// @param destination     Destination chain ID.
    /// @param baseReward      Reward template; tokens[0].amount is the placeholder
    ///                        the helper overwrites with the selected bucket's amount.
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
