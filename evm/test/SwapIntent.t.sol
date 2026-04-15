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
import {MockDEX, ReentrantDEX} from "./mocks/MockDEX.sol";

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

        outputToken.mint(address(dex), DEX_LIQUIDITY);
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

    function _buildReward(uint256 swapOutput) internal view returns (Reward memory) {
        TokenAmount[] memory tokens = new TokenAmount[](1);
        tokens[0] = TokenAmount({token: address(outputToken), amount: swapOutput});
        return Reward({
            deadline: uint64(block.timestamp + 3600),
            creator: user,
            prover: prover,
            nativeAmount: 0,
            tokens: tokens
        });
    }

    // ─── Constructor ──────────────────────────────────────────────

    function test_constructor_setsPortal() public view {
        assertEq(address(swapIntent.portal()), address(portal));
    }

    function test_revert_constructor_zeroAddress() public {
        vm.expectRevert(ISwapIntent.InvalidPortal.selector);
        new SwapIntent(address(0));
    }

    function test_revert_constructor_nonContract() public {
        vm.expectRevert(ISwapIntent.InvalidPortal.selector);
        new SwapIntent(makeAddr("eoa"));
    }

    // ─── Happy path ───────────────────────────────────────────────

    function test_swapAndCreateIntent_success() public {
        bytes32 intentHash = _doSwap();
        assertTrue(intentHash != bytes32(0));
    }

    function test_emitsIntentCreated() public {
        // swapOutput = 1_000_000, routeAmount = 1_000_000 * 997/1000 - 5000 = 992_000
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

    function test_noFee() public {
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

    function test_skipCalldataPatch() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.calldataAmountOffset = type(uint32).max;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);
        assertTrue(intentHash != bytes32(0));
    }

    function test_allowPartialTrue() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.allowPartial = true;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);
        assertTrue(intentHash != bytes32(0));
    }

    function test_zeroInputAmount_skipsTransferFrom() public {
        // Pre-fund the contract with input tokens instead of pulling.
        inputToken.mint(address(swapIntent), SWAP_AMOUNT);

        IntentParams memory intent = _defaultIntentParams();
        Call[] memory calls = _buildSwapCalls(SWAP_AMOUNT);

        vm.prank(user);
        bytes32 intentHash = swapIntent.swapAndCreateIntent(
            address(inputToken), 0, address(outputToken), calls, intent
        );
        assertTrue(intentHash != bytes32(0));
    }

    // ─── Token & balance assertions ───────────────────────────────

    function test_contractHoldsNoTokensAfter() public {
        _doSwap();
        assertEq(inputToken.balanceOf(address(swapIntent)), 0);
        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
    }

    function test_portalApprovalResetToZero() public {
        _doSwap();
        assertEq(outputToken.allowance(address(swapIntent), address(portal)), 0);
    }

    function test_userBalancesAfterSwap() public {
        uint256 userInputBefore = inputToken.balanceOf(user);
        _doSwap();
        assertEq(inputToken.balanceOf(user), userInputBefore - SWAP_AMOUNT);
        assertEq(outputToken.balanceOf(user), 0);
    }

    function test_sweepsResidualTokens() public {
        dex.setRate(0.5e18);
        uint256 userInputBefore = inputToken.balanceOf(user);
        _doSwap();
        assertEq(inputToken.balanceOf(address(swapIntent)), 0);
        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
        assertEq(inputToken.balanceOf(user), userInputBefore - SWAP_AMOUNT);
    }

    // ─── Integration: Portal state verification ───────────────────

    function test_integration_portalIntentIsFunded() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 1;
        intent.scalarDenom = 1;
        intent.flatFee = 0;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);

        IIntentSource.Status status = portal.getRewardStatus(intentHash);
        assertEq(uint8(status), uint8(IIntentSource.Status.Funded));
    }

    function test_integration_vaultHoldsSwapOutput() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 1;
        intent.scalarDenom = 1;
        intent.flatFee = 0;

        bytes memory route = _buildRouteTemplate();
        assembly {
            mstore(add(add(route, 0x20), 32), SWAP_AMOUNT)
            mstore(add(add(route, 0x20), 96), SWAP_AMOUNT)
        }

        Reward memory reward = _buildReward(SWAP_AMOUNT);
        address vault = portal.intentVaultAddress(intent.destination, route, reward);

        _doSwap(SWAP_AMOUNT, intent);

        assertEq(outputToken.balanceOf(vault), SWAP_AMOUNT);
    }

    function test_integration_rewardStructCorrectness() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.destination = 42;
        intent.scalarNum = 1;
        intent.scalarDenom = 1;
        intent.flatFee = 0;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);

        Reward memory expectedReward = Reward({
            deadline: intent.rewardDeadline,
            creator: user,
            prover: prover,
            nativeAmount: 0,
            tokens: new TokenAmount[](1)
        });
        expectedReward.tokens[0] = TokenAmount({token: address(outputToken), amount: SWAP_AMOUNT});

        bytes memory route = _buildRouteTemplate();
        assembly {
            mstore(add(add(route, 0x20), 32), SWAP_AMOUNT)
            mstore(add(add(route, 0x20), 96), SWAP_AMOUNT)
        }

        (bytes32 expectedHash,,) = portal.getIntentHash(uint64(42), route, expectedReward);
        assertEq(intentHash, expectedHash);
    }

    function test_integration_routePatchCorrectness() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = 1;
        intent.scalarDenom = 1;
        intent.flatFee = 0;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);

        bytes memory expectedRoute = _buildRouteTemplate();
        assembly {
            mstore(add(add(expectedRoute, 0x20), 32), SWAP_AMOUNT)
            mstore(add(add(expectedRoute, 0x20), 96), SWAP_AMOUNT)
        }

        Reward memory reward = _buildReward(SWAP_AMOUNT);
        (bytes32 expectedHash,,) = portal.getIntentHash(uint64(1), expectedRoute, reward);
        assertEq(intentHash, expectedHash);
    }

    function test_integration_feeAdjustedRouteAndReward() public {
        // swapOutput = 1_000_000, routeAmount = 992_000, rewardAmount = 1_000_000
        bytes32 intentHash = _doSwap();

        bytes memory expectedRoute = _buildRouteTemplate();
        uint256 expectedRouteAmount = 992_000;
        assembly {
            mstore(add(add(expectedRoute, 0x20), 32), expectedRouteAmount)
            mstore(add(add(expectedRoute, 0x20), 96), expectedRouteAmount)
        }

        Reward memory reward = _buildReward(SWAP_AMOUNT);
        (bytes32 expectedHash,,) = portal.getIntentHash(uint64(1), expectedRoute, reward);
        assertEq(intentHash, expectedHash);
    }

    // ─── Reentrancy ───────────────────────────────────────────────

    function test_revert_reentrancy() public {
        ReentrantDEX reentrantDex = new ReentrantDEX(
            address(swapIntent), address(inputToken), address(outputToken)
        );

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(reentrantDex),
            data: abi.encodeWithSelector(ReentrantDEX.swap.selector, SWAP_AMOUNT),
            value: 0
        });

        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert();
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }

    // ─── Call target validation ───────────────────────────────────

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

    function test_revert_portalCallTarget() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(portal),
            data: abi.encodeWithSelector(bytes4(keccak256("publish(uint64,bytes,Reward)"))),
            value: 0
        });
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(ISwapIntent.InvalidCallTarget.selector, address(portal)));
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }

    function test_revert_invalidTargetNotFirstIndex() public {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(inputToken),
            data: abi.encodeWithSelector(IERC20.approve.selector, address(dex), SWAP_AMOUNT),
            value: 0
        });
        calls[1] = Call({target: address(swapIntent), data: "", value: 0});

        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(ISwapIntent.InvalidCallTarget.selector, address(swapIntent)));
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }

    // ─── Call failures ────────────────────────────────────────────

    function test_revert_callFailed() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(dex),
            data: abi.encodeWithSelector(MockDEX.swap.selector, SWAP_AMOUNT),
            value: 0
        });
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert();
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }

    function test_revert_callFailedSecondIndex() public {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(inputToken),
            data: abi.encodeWithSelector(IERC20.approve.selector, address(dex), SWAP_AMOUNT),
            value: 0
        });
        calls[1] = Call({
            target: address(dex),
            data: abi.encodeWithSelector(MockDEX.swap.selector, SWAP_AMOUNT * 100),
            value: 0
        });
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert();
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }

    function test_revert_emptyCalls() public {
        Call[] memory calls = new Call[](0);
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InsufficientSwapOutput.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent
        );
        vm.stopPrank();
    }

    // ─── Scalar validation ────────────────────────────────────────

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

    // ─── Fee / amount errors ──────────────────────────────────────

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

    function test_revert_routeAmountZero() public {
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
        IntentParams memory intent = _defaultIntentParams();
        intent.flatFee = 1_000_000;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.RouteAmountZero.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    // ─── Offset errors ────────────────────────────────────────────

    function test_revert_tokensOffsetOutOfBounds() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.tokensAmountOffset = 200;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.OffsetOutOfBounds.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    function test_revert_calldataOffsetOutOfBounds() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.tokensAmountOffset = 32;
        intent.calldataAmountOffset = 200;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.OffsetOutOfBounds.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent
        );
        vm.stopPrank();
    }

    // ─── Fuzz tests ───────────────────────────────────────────────

    function testFuzz_feeCalculation(
        uint128 swapOutput,
        uint128 scalarNum,
        uint128 scalarDenom,
        uint128 flatFee
    ) public {
        vm.assume(swapOutput > 0);
        vm.assume(scalarDenom > 0);
        vm.assume(scalarNum > 0 && scalarNum <= scalarDenom);

        uint256 scaled = (uint256(swapOutput) * uint256(scalarNum)) / uint256(scalarDenom);
        vm.assume(flatFee < scaled);
        uint256 expectedRouteAmount = scaled - uint256(flatFee);
        vm.assume(expectedRouteAmount > 0);

        // Configure DEX to output exactly swapOutput for a fixed input.
        uint256 inputAmount = 1_000_000;
        uint256 dexRate = (uint256(swapOutput) * 1e18) / inputAmount;
        vm.assume(dexRate > 0);
        uint256 actualOutput = (inputAmount * dexRate) / 1e18;
        vm.assume(actualOutput == swapOutput && actualOutput > 0);

        // Recalculate with actual output to ensure consistency.
        uint256 actualScaled = (actualOutput * uint256(scalarNum)) / uint256(scalarDenom);
        vm.assume(uint256(flatFee) < actualScaled);

        dex.setRate(dexRate);
        inputToken.mint(user, inputAmount);
        outputToken.mint(address(dex), actualOutput);

        IntentParams memory intent = _defaultIntentParams();
        intent.scalarNum = uint256(scalarNum);
        intent.scalarDenom = uint256(scalarDenom);
        intent.flatFee = uint256(flatFee);

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), inputAmount);
        swapIntent.swapAndCreateIntent(
            address(inputToken), inputAmount, address(outputToken), _buildSwapCalls(inputAmount), intent
        );
        vm.stopPrank();

        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
        assertEq(inputToken.balanceOf(address(swapIntent)), 0);
    }
}
