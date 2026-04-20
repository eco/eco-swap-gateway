// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Call, Reward, TokenAmount} from "eco-routes/contracts/types/Intent.sol";
import {Portal} from "eco-routes/contracts/Portal.sol";
import {IIntentSource} from "eco-routes/contracts/interfaces/IIntentSource.sol";
import {TestERC20} from "eco-routes/contracts/test/TestERC20.sol";

import {SwapIntent} from "../contracts/SwapIntent.sol";
import {ISwapIntent, IntentParams, RouteType} from "../contracts/interfaces/ISwapIntent.sol";
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
            feeNumerator: 997,
            feeDenominator: 1000,
            sourceDecimals: 18,
            destinationDecimals: 18,
            allowPartial: false,
            routeType: RouteType.EVM
        });
    }

    function _doSwap() internal returns (bytes32) {
        return _doSwap(SWAP_AMOUNT, _defaultIntentParams());
    }

    function _doSwap(uint256 amount, IntentParams memory intent) internal returns (bytes32) {
        return _doSwap(amount, intent, 0);
    }

    function _doSwap(uint256 amount, IntentParams memory intent, uint256 rewardAmount) internal returns (bytes32) {
        vm.startPrank(user);
        inputToken.approve(address(swapIntent), amount);
        bytes32 intentHash = swapIntent.swapAndCreateIntent(
            address(inputToken), amount, address(outputToken), _buildSwapCalls(amount), intent, rewardAmount, user
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
        assertEq(address(swapIntent.PORTAL()), address(portal));
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
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);

        vm.expectEmit(false, true, false, true);
        emit ISwapIntent.IntentCreated(bytes32(0), user, SWAP_AMOUNT);

        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    function test_feeCalculation() public {
        // 2_000_000 * 995 / 1000 - 10_000 = 1_980_000
        uint256 amount = 2_000_000;
        inputToken.mint(user, amount);

        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 995;
        intent.feeDenominator = 1000;
        intent.flatFee = 10_000;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), amount);

        vm.expectEmit(false, true, false, true);
        emit ISwapIntent.IntentCreated(bytes32(0), user, amount);

        swapIntent.swapAndCreateIntent(
            address(inputToken), amount, address(outputToken), _buildSwapCalls(amount), intent, 0, user
        );
        vm.stopPrank();
    }

    function test_noFee() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);

        vm.expectEmit(false, true, false, true);
        emit ISwapIntent.IntentCreated(bytes32(0), user, SWAP_AMOUNT);

        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
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

    // ─── Input validation ────────────────────────────────────────

    function test_revert_zeroInputAmount() public {
        IntentParams memory intent = _defaultIntentParams();
        Call[] memory calls = _buildSwapCalls(SWAP_AMOUNT);

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidInputAmount.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), 0, address(outputToken), calls, intent, 0, user
        );
        vm.stopPrank();
    }

    function test_revert_invalidSweepRecipient_zero() public {
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidSweepRecipient.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, address(0)
        );
        vm.stopPrank();
    }

    function test_revert_invalidSweepRecipient_self() public {
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidSweepRecipient.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            intent,
            0,
            address(swapIntent)
        );
        vm.stopPrank();
    }

    function test_revert_invalidRewardCreator() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.rewardCreator = address(0);

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidRewardCreator.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    function test_revert_invalidRewardProver() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.rewardProver = address(0);

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidRewardProver.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
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

    function test_inputTokenApprovalResetToZero() public {
        _doSwap();
        // Approval for each swap call target should be zeroed.
        assertEq(inputToken.allowance(address(swapIntent), address(inputToken)), 0);
        assertEq(inputToken.allowance(address(swapIntent), address(dex)), 0);
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

    function test_sweepsETH() public {
        vm.deal(user, 1 ether);
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        swapIntent.swapAndCreateIntent{value: 1 ether}(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();

        assertEq(address(swapIntent).balance, 0);
        assertEq(user.balance, 1 ether);
    }

    // ─── Custom reward amount ────────────────────────────────────

    function test_customRewardAmount() public {
        uint256 customReward = 800_000;
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent, customReward);
        assertTrue(intentHash != bytes32(0));

        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
        assertEq(outputToken.balanceOf(user), SWAP_AMOUNT - customReward);
    }

    function test_customRewardAmount_sweepsToRecipient() public {
        address recipient = makeAddr("recipient");
        uint256 customReward = 600_000;
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        swapIntent.swapAndCreateIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            intent,
            customReward,
            recipient
        );
        vm.stopPrank();

        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
        assertEq(outputToken.balanceOf(recipient), SWAP_AMOUNT - customReward);
        assertEq(outputToken.balanceOf(user), 0);
    }

    function test_zeroRewardAmount_usesFullSwapOutput() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        _doSwap(SWAP_AMOUNT, intent, 0);
        assertEq(outputToken.balanceOf(user), 0);
        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
    }

    function test_revert_rewardExceedsSwapOutput() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.RewardExceedsSwapOutput.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, SWAP_AMOUNT + 1, user
        );
        vm.stopPrank();
    }

    // ─── Integration: Portal state verification ───────────────────

    function test_integration_portalIntentIsFunded() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);

        IIntentSource.Status status = portal.getRewardStatus(intentHash);
        assertEq(uint8(status), uint8(IIntentSource.Status.Funded));
    }

    function test_integration_vaultHoldsSwapOutput() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
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
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
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
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
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

    function test_integration_defaultReward_vaultHoldsFullSwapOutput() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        bytes memory route = _buildRouteTemplate();
        assembly {
            mstore(add(add(route, 0x20), 32), SWAP_AMOUNT)
            mstore(add(add(route, 0x20), 96), SWAP_AMOUNT)
        }

        Reward memory reward = _buildReward(SWAP_AMOUNT);
        address vault = portal.intentVaultAddress(intent.destination, route, reward);

        _doSwap(SWAP_AMOUNT, intent, 0);

        assertEq(outputToken.balanceOf(vault), SWAP_AMOUNT);
        assertEq(outputToken.balanceOf(user), 0);
    }

    function test_integration_customReward_vaultHoldsPartial() public {
        uint256 customReward = 800_000;
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        bytes memory route = _buildRouteTemplate();
        assembly {
            mstore(add(add(route, 0x20), 32), SWAP_AMOUNT)
            mstore(add(add(route, 0x20), 96), SWAP_AMOUNT)
        }

        TokenAmount[] memory tokens = new TokenAmount[](1);
        tokens[0] = TokenAmount({token: address(outputToken), amount: customReward});
        Reward memory reward = Reward({
            deadline: intent.rewardDeadline,
            creator: user,
            prover: prover,
            nativeAmount: 0,
            tokens: tokens
        });
        address vault = portal.intentVaultAddress(intent.destination, route, reward);

        _doSwap(SWAP_AMOUNT, intent, customReward);

        assertEq(outputToken.balanceOf(vault), customReward);
        assertEq(outputToken.balanceOf(user), SWAP_AMOUNT - customReward);
        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, 0, user
        );
        vm.stopPrank();
    }

    // ─── Call target validation ───────────────────────────────────

    function test_revert_selfCall() public {
        // Self-calls fail via CallFailed wrapping ReentrancyGuardReentrantCall.
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(swapIntent),
            data: abi.encodeWithSelector(SwapIntent.swapAndCreateIntent.selector),
            value: 0
        });
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert();
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, 0, user
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, 0, user
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
        calls[1] = Call({target: address(portal), data: "", value: 0});

        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(ISwapIntent.InvalidCallTarget.selector, address(portal)));
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, 0, user
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, 0, user
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, 0, user
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, 0, user
        );
        vm.stopPrank();
    }

    // ─── Scalar validation ────────────────────────────────────────

    function test_revert_zeroDenom() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeDenominator = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidScalar.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    function test_revert_zeroNum() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 0;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidScalar.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    function test_revert_numGreaterThanDenom() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1001;
        intent.feeDenominator = 1000;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InvalidScalar.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    // ─── Fee / amount errors ──────────────────────────────────────

    function test_revert_zeroSwapOutput() public {
        dex.setRate(0);
        IntentParams memory intent = _defaultIntentParams();
        intent.flatFee = 0;
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.InsufficientSwapOutput.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    function test_revert_routeAmountZero() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = SWAP_AMOUNT;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.RouteAmountZero.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
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
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    // ─── Decimal conversion ─────────────────────────────────────────

    function test_decimalConversion_sourceGreaterThanDest() public {
        // 18 → 6 decimals: routeAmount = 2e12 / 1e12 = 2
        uint256 amount = 2_000_000_000_000;
        inputToken.mint(user, amount);
        outputToken.mint(address(dex), amount);

        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.sourceDecimals = 18;
        intent.destinationDecimals = 6;

        bytes32 intentHash = _doSwap(amount, intent);

        // Verify routeAmount via intent hash
        bytes memory expectedRoute = _buildRouteTemplate();
        uint256 expectedRouteAmount = 2;
        assembly {
            mstore(add(add(expectedRoute, 0x20), 32), expectedRouteAmount)
            mstore(add(add(expectedRoute, 0x20), 96), expectedRouteAmount)
        }
        Reward memory reward = _buildReward(amount);
        (bytes32 expectedHash,,) = portal.getIntentHash(uint64(1), expectedRoute, reward);
        assertEq(intentHash, expectedHash);
    }

    function test_decimalConversion_destGreaterThanSource() public {
        // 6 → 18 decimals: routeAmount = 1_000_000 * 1e12 = 1e18
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.sourceDecimals = 6;
        intent.destinationDecimals = 18;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);

        bytes memory expectedRoute = _buildRouteTemplate();
        uint256 expectedRouteAmount = 1_000_000_000_000_000_000;
        assembly {
            mstore(add(add(expectedRoute, 0x20), 32), expectedRouteAmount)
            mstore(add(add(expectedRoute, 0x20), 96), expectedRouteAmount)
        }
        Reward memory reward = _buildReward(SWAP_AMOUNT);
        (bytes32 expectedHash,,) = portal.getIntentHash(uint64(1), expectedRoute, reward);
        assertEq(intentHash, expectedHash);
    }

    function test_decimalConversion_sameDecimals() public {
        // 18 → 18: routeAmount == SWAP_AMOUNT
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.sourceDecimals = 18;
        intent.destinationDecimals = 18;

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

    function test_revert_decimalConversion_truncatesToZero() public {
        // 18 → 6 with tiny swapOutput: routeAmount truncates to 0
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.sourceDecimals = 18;
        intent.destinationDecimals = 6;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.RouteAmountZero.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    // ─── SVM route patching ──────────────────────────────────────

    function test_svmRoutePatch() public {
        // SVM routes use u64 little-endian (8 bytes) instead of uint256 (32 bytes).
        // Build a smaller template where offsets point to 8-byte slots.
        bytes memory svmTemplate = new bytes(32);
        IntentParams memory intent = _defaultIntentParams();
        intent.routeTemplate = svmTemplate;
        intent.tokensAmountOffset = 0;
        intent.calldataAmountOffset = 16;
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.routeType = RouteType.SVM;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);
        assertTrue(intentHash != bytes32(0));
    }

    function test_svmRoutePatch_skipCalldata() public {
        bytes memory svmTemplate = new bytes(16);
        IntentParams memory intent = _defaultIntentParams();
        intent.routeTemplate = svmTemplate;
        intent.tokensAmountOffset = 0;
        intent.calldataAmountOffset = type(uint32).max;
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.routeType = RouteType.SVM;

        bytes32 intentHash = _doSwap(SWAP_AMOUNT, intent);
        assertTrue(intentHash != bytes32(0));
    }

    function test_revert_svmAmountOverflowU64() public {
        // Force a routeAmount > type(uint64).max via large swap output + decimal upscaling
        uint256 largeAmount = 2_000_000_000_000_000_000; // 2e18
        inputToken.mint(user, largeAmount);
        outputToken.mint(address(dex), largeAmount);

        bytes memory svmTemplate = new bytes(32);
        IntentParams memory intent = _defaultIntentParams();
        intent.routeTemplate = svmTemplate;
        intent.tokensAmountOffset = 0;
        intent.calldataAmountOffset = type(uint32).max;
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.sourceDecimals = 6;
        intent.destinationDecimals = 18;
        intent.routeType = RouteType.SVM;
        // routeAmount = 2e18 * 1e12 = 2e30, which overflows u64

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), largeAmount);
        vm.expectRevert(ISwapIntent.AmountOverflowU64.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), largeAmount, address(outputToken), _buildSwapCalls(largeAmount), intent, 0, user
        );
        vm.stopPrank();
    }

    function test_revert_svmOffsetOutOfBounds() public {
        bytes memory svmTemplate = new bytes(4); // too small for 8-byte patch
        IntentParams memory intent = _defaultIntentParams();
        intent.routeTemplate = svmTemplate;
        intent.tokensAmountOffset = 0;
        intent.calldataAmountOffset = type(uint32).max;
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;
        intent.routeType = RouteType.SVM;

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.OffsetOutOfBounds.selector);
        swapIntent.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, 0, user
        );
        vm.stopPrank();
    }

    // ─── ETH sweep failures ──────────────────────────────────────

    function test_revert_nativeTransferFailed() public {
        // Use a contract that rejects ETH as sweepRecipient
        ETHRejecter rejecter = new ETHRejecter();
        vm.deal(user, 1 ether);
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), SWAP_AMOUNT);
        vm.expectRevert(ISwapIntent.NativeTransferFailed.selector);
        swapIntent.swapAndCreateIntent{value: 1 ether}(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            intent,
            0,
            address(rejecter)
        );
        vm.stopPrank();
    }

    // ─── Fuzz tests ───────────────────────────────────────────────

    function testFuzz_feeCalculation(
        uint128 swapOutput,
        uint128 feeNumerator,
        uint128 feeDenominator,
        uint128 flatFee
    ) public {
        vm.assume(swapOutput > 0);
        vm.assume(feeDenominator > 0);
        vm.assume(feeNumerator > 0 && feeNumerator <= feeDenominator);

        uint256 afterFees = (uint256(swapOutput) * uint256(feeNumerator)) / uint256(feeDenominator);
        vm.assume(flatFee < afterFees);
        uint256 expectedRouteAmount = afterFees - uint256(flatFee);
        vm.assume(expectedRouteAmount > 0);

        uint256 inputAmount = 1_000_000;
        uint256 dexRate = (uint256(swapOutput) * 1e18) / inputAmount;
        vm.assume(dexRate > 0);
        uint256 actualOutput = (inputAmount * dexRate) / 1e18;
        vm.assume(actualOutput == swapOutput && actualOutput > 0);

        uint256 actualAfterFees = (actualOutput * uint256(feeNumerator)) / uint256(feeDenominator);
        vm.assume(uint256(flatFee) < actualAfterFees);

        dex.setRate(dexRate);
        inputToken.mint(user, inputAmount);
        outputToken.mint(address(dex), actualOutput);

        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = uint256(feeNumerator);
        intent.feeDenominator = uint256(feeDenominator);
        intent.flatFee = uint256(flatFee);

        vm.startPrank(user);
        inputToken.approve(address(swapIntent), inputAmount);
        swapIntent.swapAndCreateIntent(
            address(inputToken), inputAmount, address(outputToken), _buildSwapCalls(inputAmount), intent, 0, user
        );
        vm.stopPrank();

        assertEq(outputToken.balanceOf(address(swapIntent)), 0);
        assertEq(inputToken.balanceOf(address(swapIntent)), 0);
    }
}

/// @notice Helper contract that rejects ETH transfers (no receive/fallback).
contract ETHRejecter {}
