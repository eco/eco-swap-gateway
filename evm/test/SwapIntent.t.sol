// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Call, Reward, TokenAmount} from "eco-routes/contracts/types/Intent.sol";
import {Portal} from "eco-routes/contracts/Portal.sol";
import {IIntentSource} from "eco-routes/contracts/interfaces/IIntentSource.sol";
import {TestERC20} from "eco-routes/contracts/test/TestERC20.sol";

import {SwapIntent} from "../contracts/SwapIntent.sol";
import {ISwapIntent, IntentParams} from "../contracts/interfaces/ISwapIntent.sol";
import {MockDEX} from "./mocks/MockDEX.sol";

contract SwapIntentTest is Test {
    SwapIntent public swapIntent;
    Portal public portal;
    TestERC20 public inputToken;
    TestERC20 public outputToken;
    MockDEX public dex;

    address public user;
    address public prover;

    uint256 constant MINT_AMOUNT = 10_000_000;
    uint256 constant SWAP_AMOUNT = 1_000_000;
    uint256 constant DEX_LIQUIDITY = 100_000_000;

    function setUp() public {
        user = makeAddr("user");
        prover = makeAddr("prover");

        portal = new Portal();
        inputToken = new TestERC20("Input", "IN");
        outputToken = new TestERC20("Output", "OUT");
        dex = new MockDEX(address(inputToken), address(outputToken));
        swapIntent = new SwapIntent(address(portal));

        // Fund DEX with output tokens.
        outputToken.mint(address(dex), DEX_LIQUIDITY);
        // Fund user with input tokens.
        inputToken.mint(user, MINT_AMOUNT);
    }

    // ─── Helpers ──────────────────────────────────────────────────

    function _buildSwapCalls(uint256 amount) internal view returns (Call[] memory) {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(inputToken),
            data: abi.encodeWithSelector(IERC20.approve.selector, address(dex), amount),
            value: 0
        });
        calls[1] = Call({
            target: address(dex),
            data: abi.encodeWithSelector(MockDEX.swap.selector, amount),
            value: 0
        });
        return calls;
    }

    function _buildRouteTemplate() internal pure returns (bytes memory) {
        // 128-byte template with placeholder zeros at offsets 32 and 96.
        return new bytes(128);
    }

    function _defaultIntentParams() internal view returns (IntentParams memory) {
        return IntentParams({
            destination: 1,
            routeTemplate: _buildRouteTemplate(),
            tokensAmountOffset: 32,
            calldataAmountOffset: 96,
            rewardDeadline: uint64(block.timestamp + 3600),
            rewardCreator: user,
            rewardProver: prover,
            flatFee: 5_000,
            scalarNum: 997,
            scalarDenom: 1000,
            allowPartial: false
        });
    }

    function _doSwap() internal returns (bytes32) {
        return _doSwap(SWAP_AMOUNT, _defaultIntentParams());
    }

    function _doSwap(uint256 amount, IntentParams memory intent) internal returns (bytes32) {
        vm.startPrank(user);
        inputToken.approve(address(swapIntent), amount);
        bytes32 intentHash = swapIntent.swapAndCreateIntent(
            address(inputToken), amount, address(outputToken), _buildSwapCalls(amount), intent
        );
        vm.stopPrank();
        return intentHash;
    }

    // ─── Happy path ───────────────────────────────────────────────

    function test_swapAndCreateIntent_success() public {
        bytes32 intentHash = _doSwap();
        assertTrue(intentHash != bytes32(0));
    }

    function test_emitsIntentCreated() public {
        // swapOutput = 1_000_000 (1:1 rate)
        // routeAmount = 1_000_000 * 997 / 1000 - 5000 = 992_000
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);

        vm.expectEmit(false, true, false, true);
        emit ISwapIntent.IntentCreated(bytes32(0), user, address(outputToken), SWAP_AMOUNT, 992_000, 1);

        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_feeCalculation() public {
        // 2_000_000 * 995 / 1000 - 10_000 = 1_980_000
        uint256 amount = 2_000_000;
        inputToken.mint(user, amount);

        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 995;
        intent.scalarDenom = 1000;
        intent.flatFee = 10_000;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), amount);

        vm.expectEmit(false, true, false, true);
        emit ISwapIntent.IntentCreated(bytes32(0), user, address(outputToken), amount, 1_980_000, 1);

        swapIntent.swapAndCreateIntent(
            address(inputToken), amount, address(outputToken), _buildSwapCalls(amount), intent
        );
        vm.stopPrank();
    }

    function test_skipCalldataPatch() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.calldataAmountOffset = type(uint32).max;

        // Should succeed without patching the second offset.
        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);
        assertTrue(intentHash != bytes32(0));
    }

    function test_contractHoldsNoTokensAfter() public {
        _doSwap();
        assertEq(inputToken.balanceOf(address(swapIntent)), 0);
        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
    }

    function test_sweepsResidualTokens() public {
        // Set DEX rate to 0.5x so half the input is "consumed" worth of output,
        // but the DEX still takes all input. No residual input in this case,
        // but output is less. Key check: contract balance is zero.
        dex.setRate(0.5e18);
        _doSwap();
        assertEq(inputToken.balanceOf(address(swapIntent)), 0);
        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
    }

    function test_multipleSwapCalls() public {
        // The default _buildSwapCalls already uses 2 calls (approve + swap).
        // Just verify it works end-to-end.
        bytes32 intentHash = _doSwap();
        assertTrue(intentHash != bytes32(0));
    }

    function test_noFee() public {
        // scalarNum == scalarDenom and flatFee == 0 -> routeAmount == swapOutput
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 1;
        intent.scalarDenom = 1;
        intent.flatFee = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);

        vm.expectEmit(false, true, false, true);
        emit ISwapIntent.IntentCreated(bytes32(0), user, address(outputToken), SWAP_AMOUNT, SWAP_AMOUNT, 1);

        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    // ─── Reverts ──────────────────────────────────────────────────

    function test_revert_zeroSwapOutput() public {
        dex.setRate(0);
        IntentParams memory intent = _defaultIntentParams();
        intent.flatFee = 0;
        intent.scalarNum = 1;
        intent.scalarDenom = 1;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InsufficientSwapOutput.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_zeroDenom() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarDenom = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidScalar.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_zeroNum() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidScalar.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_numGreaterThanDenom() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 1001;
        intent.scalarDenom = 1000;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidScalar.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_routeAmountZero() public {
        // flatFee eats everything: 1_000_000 * 1 / 1 - 1_000_000 = 0
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 1;
        intent.scalarDenom = 1;
        intent.flatFee = SWAP_AMOUNT;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.RouteAmountZero.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_flatFeeExceedsScaled() public {
        // scaled = 1_000_000 * 997 / 1000 = 997_000; flatFee = 1_000_000 -> underflow
        IntentParams memory intent = _defaultIntentParams();
        intent.flatFee = 1_000_000;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(); // arithmetic underflow
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_offsetOutOfBounds() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.tokensAmountOffset = 200; // route is only 128 bytes

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.OffsetOutOfBounds.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_callFailed() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(dex),
            data: abi.encodeWithSelector(MockDEX.swap.selector, SWAP_AMOUNT),
            value: 0
        });
        // No approve -> DEX transferFrom will fail -> CallFailed(0)
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(ISwapIntent.CallFailed.selector, 0));
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }

    function test_revert_selfCall() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(swapIntent),
            data: abi.encodeWithSelector(SwapIntent.swapAndCreateIntent.selector),
            value: 0
        });
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(ISwapIntent.InvalidCallTarget.selector, address(swapIntent)));
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }
}
