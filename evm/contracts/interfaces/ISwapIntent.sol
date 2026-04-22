// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Call} from "eco-routes/contracts/types/Intent.sol";

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

interface ISwapIntent {
    // --- Events ---

    event IntentCreated(bytes32 indexed intentHash, address indexed user, uint256 swapOutput);

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
    error RewardExceedsSwapOutput();
    error NativeTransferFailed();
    error AmountOverflowU64();

    // --- Core ---

    /// @notice Executes swap calls, measures the output delta, and creates + funds
    ///         an intent via Portal.publishAndFund.
    /// @dev Does not support fee-on-transfer tokens as outputToken. The reward amount
    ///      is set to the raw balance delta, which would be incorrect for deflationary
    ///      tokens since a second transfer fee applies when funding the Portal vault.
    ///      Callers must include token approval calls (e.g., inputToken.approve(dex, amount))
    ///      in the swapCalls array — the contract does not pre-approve any targets.
    ///      This helper supports both EVM and SVM destination routes via RouteType.
    /// @param inputToken      ERC20 token to pull from the caller.
    /// @param inputAmount     Amount of inputToken to pull (must be > 0).
    /// @param outputToken     ERC20 token expected from the swap (reward token).
    /// @param swapCalls       Arbitrary calls for swap execution (approve, swap, etc.).
    /// @param intent          Intent creation parameters.
    /// @param rewardAmount    Reward locked for the solver. 0 = use full swapOutput.
    ///                        For any-to-any flows, set explicitly so the excess can be
    ///                        swept and used to fund a second intent.
    /// @param sweepRecipient  Address to receive residual tokens and ETH after the swap.
    /// @return intentHash Hash of the created intent.
    function swapAndCreateIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata swapCalls,
        IntentParams calldata intent,
        uint256 rewardAmount,
        address sweepRecipient
    ) external payable returns (bytes32 intentHash);
}
