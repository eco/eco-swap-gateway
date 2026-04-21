// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Call, Reward, TokenAmount} from "eco-routes/contracts/types/Intent.sol";
import {IIntentSource} from "eco-routes/contracts/interfaces/IIntentSource.sol";
import {Endian} from "eco-routes/contracts/libs/Endian.sol";

import {IEcoSwapGateway, IntentParams, RouteType, Bucket} from "./interfaces/IEcoSwapGateway.sol";

/// @title EcoSwapGateway
/// @notice Atomically swaps tokens via arbitrary DEX calls, patches the
///         caller-supplied route template with the computed route amount, and
///         creates + funds a Portal intent. Reward always equals the full
///         swap output.
/// @dev Does not support fee-on-transfer tokens as outputToken.
///      Supports both EVM and SVM destination routes via RouteType.
contract EcoSwapGateway is IEcoSwapGateway, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Sentinel value: skip calldata offset patching.
    uint32 public constant SKIP_CALLDATA_PATCH = type(uint32).max;

    /// @notice The Portal contract used to publish and fund intents.
    IIntentSource public immutable PORTAL;

    constructor(address _portal) {
        if (_portal == address(0) || _portal.code.length == 0) {
            revert InvalidPortal();
        }
        PORTAL = IIntentSource(_portal);
    }

    /// @dev Accepts ETH refunds from DEX routers during multi-hop swaps.
    receive() external payable {}

    /// @inheritdoc IEcoSwapGateway
    function swapAndCreateIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata swapCalls,
        IntentParams calldata intent,
        address sweepRecipient
    ) external payable nonReentrant returns (bytes32 intentHash) {
        // 1. Validate parameters.
        address resolvedSweep = _resolveSweepRecipient(sweepRecipient);
        if (intent.rewardCreator == address(0)) revert InvalidRewardCreator();
        if (intent.rewardProver == address(0)) revert InvalidRewardProver();
        if (intent.feeDenominator == 0 || intent.feeNumerator == 0 || intent.feeNumerator > intent.feeDenominator) {
            revert InvalidScalar();
        }

        // 2. Pull input tokens and execute swap.
        uint256 swapOutput = _executeSwap(inputToken, inputAmount, outputToken, swapCalls);

        // 3. Calculate route amount and patch route template.
        bytes memory route = _buildRoute(swapOutput, intent);

        // 4. Publish and fund intent (reward = full swap output).
        intentHash = _publishAndFund(outputToken, swapOutput, route, intent);

        // 5. Emit event.
        emit IntentCreated(intentHash, msg.sender, swapOutput);

        // 6. Cleanup: reset approvals, sweep residual tokens and ETH.
        IERC20(outputToken).forceApprove(address(PORTAL), 0);
        for (uint256 i; i < swapCalls.length; ++i) {
            IERC20(inputToken).forceApprove(swapCalls[i].target, 0);
        }
        _sweepToken(inputToken, resolvedSweep);
        _sweepToken(outputToken, resolvedSweep);
        _sweepETH(resolvedSweep);
    }

    function _resolveSweepRecipient(address sweepRecipient) internal view returns (address resolved) {
        resolved = sweepRecipient == address(0) ? msg.sender : sweepRecipient;
        if (resolved == address(this) || resolved == address(PORTAL)) {
            revert InvalidSweepRecipient();
        }
    }

    /// @inheritdoc IEcoSwapGateway
    function swapAndSelectIntent(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata swapCalls,
        uint64 destination,
        Reward calldata baseReward,
        Bucket[] calldata buckets,
        address sweepRecipient
    ) external payable nonReentrant returns (bytes32 intentHash) {
        // 1. Validate parameters.
        address resolvedSweep = _resolveSweepRecipient(sweepRecipient);
        _validateBaseReward(baseReward, outputToken);

        // 2. Pull input tokens and execute swap.
        uint256 swapOutput = _executeSwap(inputToken, inputAmount, outputToken, swapCalls);

        // 3. Single-pass ascending validation + floor selection.
        uint256 k = _selectBucket(buckets, swapOutput);
        uint256 rewardAmount = buckets[k].rewardAmount;

        // 4. Clone the reward template with the bucket's amount.
        Reward memory reward = _cloneRewardWithAmount(baseReward, rewardAmount);

        // 5. Fund the selected intent (allowPartial=true → front-run funding is a no-op).
        IERC20(outputToken).forceApprove(address(PORTAL), rewardAmount);
        intentHash = PORTAL.fund(destination, buckets[k].routeHash, reward, true);

        // 6. Emit selection event with bucketsHash for audit.
        emit IntentSelected(
            intentHash, msg.sender, swapOutput, k, rewardAmount, keccak256(abi.encode(buckets))
        );

        // 7. Cleanup: reset approvals, sweep residuals + surplus.
        IERC20(outputToken).forceApprove(address(PORTAL), 0);
        for (uint256 i; i < swapCalls.length; ++i) {
            IERC20(inputToken).forceApprove(swapCalls[i].target, 0);
        }
        _sweepToken(inputToken, resolvedSweep);
        _sweepToken(outputToken, resolvedSweep);
        _sweepETH(resolvedSweep);
    }

    function _validateBaseReward(Reward calldata baseReward, address outputToken) internal pure {
        if (baseReward.creator == address(0)) revert InvalidRewardCreator();
        if (baseReward.prover == address(0)) revert InvalidRewardProver();
        if (baseReward.nativeAmount != 0) revert InvalidBaseReward();
        if (baseReward.tokens.length != 1) revert InvalidBaseReward();
        if (baseReward.tokens[0].token != outputToken) revert InvalidBaseReward();
        if (baseReward.tokens[0].amount != 0) revert InvalidBaseReward();
    }

    /// @dev Scans `buckets` in a single pass that both enforces strict ascending
    ///      order and picks the largest index whose `rewardAmount <= swapOutput`.
    ///      If `swapOutput` exceeds the top bucket, selection naturally caps at
    ///      `N - 1` (surplus falls to `sweepRecipient`).
    function _selectBucket(Bucket[] calldata buckets, uint256 swapOutput)
        internal
        pure
        returns (uint256 k)
    {
        uint256 n = buckets.length;
        if (n == 0) revert EmptyBuckets();
        uint256 floor0 = buckets[0].rewardAmount;
        if (swapOutput < floor0) revert SwapOutputBelowMinBucket();

        k = 0;
        uint256 prev = floor0;
        for (uint256 i = 1; i < n; ++i) {
            uint256 current = buckets[i].rewardAmount;
            if (current <= prev) revert BucketsNotAscending();
            if (current <= swapOutput) k = i;
            prev = current;
        }
    }

    function _cloneRewardWithAmount(Reward calldata baseReward, uint256 amount)
        internal
        pure
        returns (Reward memory reward)
    {
        TokenAmount[] memory tokens = new TokenAmount[](1);
        tokens[0] = TokenAmount({token: baseReward.tokens[0].token, amount: amount});
        reward = Reward({
            deadline: baseReward.deadline,
            creator: baseReward.creator,
            prover: baseReward.prover,
            nativeAmount: 0,
            tokens: tokens
        });
    }

    // --- Internal helpers ---

    function _executeSwap(
        address inputToken,
        uint256 inputAmount,
        address outputToken,
        Call[] calldata swapCalls
    ) internal returns (uint256 swapOutput) {
        if (inputAmount == 0) revert InvalidInputAmount();
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);

        uint256 preBalance = IERC20(outputToken).balanceOf(address(this));

        for (uint256 i; i < swapCalls.length; ++i) {
            if (swapCalls[i].target == address(PORTAL)) {
                revert InvalidCallTarget(swapCalls[i].target);
            }
            (bool success, bytes memory returnData) =
                swapCalls[i].target.call{value: swapCalls[i].value}(swapCalls[i].data);
            if (!success) revert CallFailed(i, returnData);
        }

        swapOutput = IERC20(outputToken).balanceOf(address(this)) - preBalance;
        if (swapOutput == 0) revert InsufficientSwapOutput();
    }

    function _buildRoute(uint256 swapOutput, IntentParams calldata intent)
        internal
        pure
        returns (bytes memory route)
    {
        uint256 afterFees = (swapOutput * intent.feeNumerator) / intent.feeDenominator;
        if (afterFees <= intent.flatFee) revert RouteAmountZero();
        uint256 routeAmount = afterFees - intent.flatFee;

        if (intent.sourceDecimals > intent.destinationDecimals) {
            routeAmount = routeAmount / (10 ** (intent.sourceDecimals - intent.destinationDecimals));
        } else if (intent.destinationDecimals > intent.sourceDecimals) {
            routeAmount = routeAmount * (10 ** (intent.destinationDecimals - intent.sourceDecimals));
        }
        if (routeAmount == 0) revert RouteAmountZero();

        route = _patchRoute(
            intent.routeTemplate, intent.tokensAmountOffset, intent.calldataAmountOffset, routeAmount, intent.routeType
        );
    }

    function _publishAndFund(
        address outputToken,
        uint256 swapOutput,
        bytes memory route,
        IntentParams calldata intent
    ) internal returns (bytes32 intentHash) {
        TokenAmount[] memory tokens = new TokenAmount[](1);
        tokens[0] = TokenAmount({token: outputToken, amount: swapOutput});
        Reward memory reward = Reward({
            deadline: intent.rewardDeadline,
            creator: intent.rewardCreator,
            prover: intent.rewardProver,
            nativeAmount: 0,
            tokens: tokens
        });

        IERC20(outputToken).forceApprove(address(PORTAL), swapOutput);
        (intentHash,) = PORTAL.publishAndFund(intent.destination, route, reward, intent.allowPartial);
    }

    function _patchRoute(
        bytes calldata template,
        uint32 tokensOffset,
        uint32 calldataOffset,
        uint256 value,
        RouteType routeType
    ) internal pure returns (bytes memory route) {
        route = bytes(template);
        if (routeType == RouteType.SVM) {
            _patchU64LE(route, tokensOffset, value);
            if (calldataOffset != SKIP_CALLDATA_PATCH) {
                _patchU64LE(route, calldataOffset, value);
            }
        } else {
            _patchUint256(route, tokensOffset, value);
            if (calldataOffset != SKIP_CALLDATA_PATCH) {
                _patchUint256(route, calldataOffset, value);
            }
        }
    }

    function _patchUint256(bytes memory data, uint32 offset, uint256 value) internal pure {
        if (uint256(offset) + 32 > data.length) revert OffsetOutOfBounds();
        assembly {
            mstore(add(add(data, 0x20), offset), value)
        }
    }

    function _patchU64LE(bytes memory data, uint32 offset, uint256 value) internal pure {
        if (value > type(uint64).max) revert AmountOverflowU64();
        if (uint256(offset) + 8 > data.length) revert OffsetOutOfBounds();
        bytes8 leValue = Endian.toLittleEndian64(uint64(value));
        for (uint256 i; i < 8; ++i) {
            data[offset + i] = leValue[i];
        }
    }

    function _sweepToken(address token, address to) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(to, balance);
        }
    }

    function _sweepETH(address to) internal {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool ok,) = to.call{value: balance}("");
            if (!ok) revert NativeTransferFailed();
        }
    }
}
