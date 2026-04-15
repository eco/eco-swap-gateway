// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwapIntent} from "../../contracts/SwapIntent.sol";
import {Call} from "eco-routes/contracts/types/Intent.sol";
import {IntentParams} from "../../contracts/interfaces/ISwapIntent.sol";

/// @notice Minimal DEX mock for testing SwapIntent. Swaps input for output at a
///         configurable rate (default 1:1). The DEX must hold output tokens.
contract MockDEX {
    IERC20 public immutable inputToken;
    IERC20 public immutable outputToken;

    /// @notice Output per input, scaled by 1e18. Default = 1e18 (1:1).
    uint256 public rate = 1e18;

    constructor(address _inputToken, address _outputToken) {
        inputToken = IERC20(_inputToken);
        outputToken = IERC20(_outputToken);
    }

    function setRate(uint256 _rate) external {
        rate = _rate;
    }

    function swap(uint256 amountIn) external returns (uint256 amountOut) {
        inputToken.transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rate) / 1e18;
        outputToken.transfer(msg.sender, amountOut);
    }
}

/// @notice DEX mock that attempts to re-enter SwapIntent during swap.
contract ReentrantDEX {
    SwapIntent public immutable target;
    IERC20 public immutable inputToken;
    IERC20 public immutable outputToken;

    constructor(address _target, address _inputToken, address _outputToken) {
        target = SwapIntent(_target);
        inputToken = IERC20(_inputToken);
        outputToken = IERC20(_outputToken);
    }

    function swap(uint256) external {
        // Attempt reentrancy into swapAndCreateIntent.
        Call[] memory calls = new Call[](0);
        IntentParams memory intent = IntentParams({
            destination: 1,
            routeTemplate: new bytes(64),
            tokensAmountOffset: 0,
            calldataAmountOffset: type(uint32).max,
            rewardDeadline: uint64(block.timestamp + 3600),
            rewardCreator: address(this),
            rewardProver: address(this),
            flatFee: 0,
            scalarNum: 1,
            scalarDenom: 1,
            sourceDecimals: 18,
            destinationDecimals: 18,
            allowPartial: false
        });
        target.swapAndCreateIntent(address(inputToken), 0, address(outputToken), calls, intent);
    }
}
