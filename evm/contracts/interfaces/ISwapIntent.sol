// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Call} from "eco-routes/contracts/types/Intent.sol";

/// @notice Parameters for creating an intent from a swap output.
struct IntentParams {
    uint64 destination;
    bytes routeTemplate;
    uint32 tokensAmountOffset;
    uint32 calldataAmountOffset;
    uint64 rewardDeadline;
    address rewardCreator;
    address rewardProver;
    uint256 flatFee;
    uint256 scalarNum;
    uint256 scalarDenom;
    bool allowPartial;
}

interface ISwapIntent {
    // --- Events ---

    event IntentCreated(
        bytes32 indexed intentHash,
        address indexed user,
        address rewardToken,
        uint256 swapOutput,
        uint256 routeAmount,
        uint64 destination
    );

    // --- Errors ---

    error InsufficientSwapOutput();
    error InvalidScalar();
    error RouteAmountZero();
    error OffsetOutOfBounds();
    error CallFailed(uint256 index, bytes reason);
    error InvalidCallTarget(address target);
    error InvalidPortal();

    // --- Core ---

    /// @notice Executes swap calls, measures the output delta, and creates + funds
    ///         an intent via Portal.publishAndFund.
    /// @dev Does not support fee-on-transfer tokens as outputToken. The reward amount
    ///      is set to the raw balance delta, which would be incorrect for deflationary
    ///      tokens since a second transfer fee applies when funding the Portal vault.
    /// @param inputToken  ERC20 token to pull from the caller.
    /// @param inputAmount Amount of inputToken to pull.
    /// @param outputToken ERC20 token expected from the swap (reward token).
    /// @param calls       Arbitrary calls for swap execution (approve, swap, etc.).
    /// @param intent      Intent creation parameters.
    /// @return intentHash Hash of the created intent.
    function swapAndCreateIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata calls,
        IntentParams calldata intent
    ) external returns (bytes32 intentHash);
}
