// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
