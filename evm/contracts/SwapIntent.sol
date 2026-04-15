// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Call, Reward, TokenAmount} from "eco-routes/contracts/types/Intent.sol";
import {IIntentSource} from "eco-routes/contracts/interfaces/IIntentSource.sol";

import {ISwapIntent, IntentParams} from "./interfaces/ISwapIntent.sol";

/// @title SwapIntent
/// @notice Atomically swaps tokens via arbitrary DEX calls and creates a Portal
///         intent whose reward amount equals the actual swap output.
/// @dev Does not support fee-on-transfer tokens as outputToken.
contract SwapIntent is ISwapIntent, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Sentinel value: skip calldata offset patching.
    uint32 public constant SKIP_CALLDATA_PATCH = type(uint32).max;

    /// @notice The Portal contract used to publish and fund intents.
    IIntentSource public immutable portal;

    constructor(address _portal) {
        if (_portal == address(0) || _portal.code.length == 0) {
            revert InvalidPortal();
        }
        portal = IIntentSource(_portal);
    }

    /// @inheritdoc ISwapIntent
    function swapAndCreateIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata calls,
        IntentParams calldata intent
    ) external nonReentrant returns (bytes32 intentHash) {
        // 1. Validate scalar parameters.
        if (intent.scalarDenom == 0 || intent.scalarNum == 0 || intent.scalarNum > intent.scalarDenom) {
            revert InvalidScalar();
        }

        // 2. Pull input tokens from the caller.
        if (inputAmount > 0) {
            IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);
        }

        // 3. Snapshot output token balance before swap.
        uint256 preBalance = IERC20(outputToken).balanceOf(address(this));

        // 4. Execute swap calls. Block calls to this contract and the portal.
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].target == address(this) || calls[i].target == address(portal)) {
                revert InvalidCallTarget(calls[i].target);
            }
            (bool success, bytes memory returnData) =
                calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) revert CallFailed(i, returnData);
        }

        // 5. Measure swap output.
        uint256 postBalance = IERC20(outputToken).balanceOf(address(this));
        uint256 swapOutput = postBalance - preBalance;
        if (swapOutput == 0) revert InsufficientSwapOutput();

        // 6. Calculate route amount: swapOutput * scalarNum / scalarDenom - flatFee.
        uint256 scaled = (swapOutput * intent.scalarNum) / intent.scalarDenom;
        if (intent.flatFee >= scaled) revert FlatFeeExceedsOutput();
        uint256 routeAmount = scaled - intent.flatFee;
        if (routeAmount == 0) revert RouteAmountZero();

        // 7. Patch route template.
        bytes memory route = _patchRoute(
            intent.routeTemplate, intent.tokensAmountOffset, intent.calldataAmountOffset, routeAmount
        );

        // 8. Build reward with actual swap output.
        TokenAmount[] memory tokens = new TokenAmount[](1);
        tokens[0] = TokenAmount({token: outputToken, amount: swapOutput});
        Reward memory reward = Reward({
            deadline: intent.rewardDeadline,
            creator: intent.rewardCreator,
            prover: intent.rewardProver,
            nativeAmount: 0,
            tokens: tokens
        });

        // 9. Approve Portal and publish + fund.
        IERC20(outputToken).forceApprove(address(portal), swapOutput);
        (intentHash,) = portal.publishAndFund(intent.destination, route, reward, intent.allowPartial);

        // 10. Emit event.
        emit IntentCreated(intentHash, msg.sender, outputToken, swapOutput, routeAmount, intent.destination);

        // 11. Cleanup: reset approval, sweep residual tokens.
        IERC20(outputToken).forceApprove(address(portal), 0);
        _sweepToken(inputToken, msg.sender);
        _sweepToken(outputToken, msg.sender);
    }

    // --- Internal helpers ---

    function _patchRoute(bytes calldata template, uint32 tokensOffset, uint32 calldataOffset, uint256 value)
        internal
        pure
        returns (bytes memory route)
    {
        route = bytes(template);
        _patchUint256(route, tokensOffset, value);
        if (calldataOffset != SKIP_CALLDATA_PATCH) {
            _patchUint256(route, calldataOffset, value);
        }
    }

    function _patchUint256(bytes memory data, uint32 offset, uint256 value) internal pure {
        if (uint256(offset) + 32 > data.length) revert OffsetOutOfBounds();
        assembly {
            mstore(add(add(data, 0x20), offset), value)
        }
    }

    function _sweepToken(address token, address to) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(to, balance);
        }
    }
}
