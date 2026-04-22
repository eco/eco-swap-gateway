// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Call, Reward, TokenAmount} from "eco-routes/contracts/types/Intent.sol";
import {Portal} from "eco-routes/contracts/Portal.sol";
import {IIntentSource} from "eco-routes/contracts/interfaces/IIntentSource.sol";
import {TestERC20} from "eco-routes/contracts/test/TestERC20.sol";

import {EcoSwapGateway} from "../contracts/EcoSwapGateway.sol";
import {IEcoSwapGateway, IntentParams, RouteType, Bucket} from "../contracts/interfaces/IEcoSwapGateway.sol";
import {MockDEX, MockETHDEX, MockTokenToETHDEX, ReentrantDEX} from "./mocks/MockDEX.sol";

contract EcoSwapGatewayTest is Test {
    EcoSwapGateway public ecoSwapGateway;
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
        ecoSwapGateway = new EcoSwapGateway(address(portal));

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
        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), amount);
        bytes32 intentHash = ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), amount, address(outputToken), _buildSwapCalls(amount), intent, user
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
        assertEq(address(ecoSwapGateway.PORTAL()), address(portal));
    }

    function test_revert_constructor_zeroAddress() public {
        vm.expectRevert(IEcoSwapGateway.InvalidPortal.selector);
        new EcoSwapGateway(address(0));
    }

    function test_revert_constructor_nonContract() public {
        vm.expectRevert(IEcoSwapGateway.InvalidPortal.selector);
        new EcoSwapGateway(makeAddr("eoa"));
    }

    // ─── Happy path ───────────────────────────────────────────────

    function test_swapAndCreateIntent_success() public {
        bytes32 intentHash = _doSwap();
        assertTrue(intentHash != bytes32(0));
    }

    function test_emitsIntentCreated() public {
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);

        vm.expectEmit(false, true, false, true);
        emit IEcoSwapGateway.IntentCreated(bytes32(0), user, SWAP_AMOUNT);

        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
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
        inputToken.approve(address(ecoSwapGateway), amount);

        vm.expectEmit(false, true, false, true);
        emit IEcoSwapGateway.IntentCreated(bytes32(0), user, amount);

        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), amount, address(outputToken), _buildSwapCalls(amount), intent, user
        );
        vm.stopPrank();
    }

    function test_noFee() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);

        vm.expectEmit(false, true, false, true);
        emit IEcoSwapGateway.IntentCreated(bytes32(0), user, SWAP_AMOUNT);

        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
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

    function test_revert_zeroInputAmount_zeroValue() public {
        IntentParams memory intent = _defaultIntentParams();
        Call[] memory calls = _buildSwapCalls(SWAP_AMOUNT);

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidInputAmount.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), 0, address(outputToken), calls, intent, user
        );
        vm.stopPrank();
    }

    function test_nativeETHInput() public {
        MockETHDEX ethDex = new MockETHDEX(address(outputToken));
        outputToken.mint(address(ethDex), 2 ether);

        uint256 ethAmount = 1 ether;
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(ethDex),
            data: abi.encodeWithSelector(MockETHDEX.swapETH.selector),
            value: ethAmount
        });

        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        vm.deal(user, ethAmount);
        vm.startPrank(user);
        bytes32 intentHash = ecoSwapGateway.swapAndCreateIntent{value: ethAmount}(
            address(0), // address(0) signals native ETH input
            0, // inputAmount ignored for native
            address(outputToken),
            calls,
            intent,
            user
        );
        vm.stopPrank();

        assertTrue(intentHash != bytes32(0));
        assertEq(user.balance, 0);
        assertEq(address(ecoSwapGateway).balance, 0);
    }

    function test_nativeETHOutput() public {
        // ERC20 input → ETH output: fund a MockTokenToETHDEX that swaps 1:1.
        MockTokenToETHDEX ethOut = new MockTokenToETHDEX(address(inputToken));
        vm.deal(address(ethOut), 2 ether);

        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(inputToken),
            data: abi.encodeWithSelector(IERC20.approve.selector, address(ethOut), SWAP_AMOUNT),
            value: 0
        });
        calls[1] = Call({
            target: address(ethOut),
            data: abi.encodeWithSelector(MockTokenToETHDEX.swapForETH.selector, SWAP_AMOUNT),
            value: 0
        });

        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = 0;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        bytes32 intentHash = ecoSwapGateway.swapAndCreateIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(0), // native ETH output
            calls,
            intent,
            user
        );
        vm.stopPrank();

        assertTrue(intentHash != bytes32(0));
        // Gateway forwarded swapOutput ETH to Portal → balance back to 0
        assertEq(address(ecoSwapGateway).balance, 0);
    }

    function test_revert_nativeInput_zeroValue() public {
        IntentParams memory intent = _defaultIntentParams();
        Call[] memory calls = _buildSwapCalls(SWAP_AMOUNT);

        vm.prank(user);
        vm.expectRevert(IEcoSwapGateway.InvalidInputAmount.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(0), 0, address(outputToken), calls, intent, user
        );
    }

    function test_sweepRecipient_zeroDefaultsToMsgSender() public {
        // Residual input tokens at DEX rate 0.5 land with the defaulted recipient (msg.sender).
        dex.setRate(0.5e18);
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            intent,
            address(0)
        );
        vm.stopPrank();

        assertEq(inputToken.balanceOf(address(ecoSwapGateway)), 0);
        assertEq(inputToken.balanceOf(user), MINT_AMOUNT - SWAP_AMOUNT);
    }

    function test_revert_invalidSweepRecipient_portal() public {
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidSweepRecipient.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            intent,
            address(portal)
        );
        vm.stopPrank();
    }

    function test_revert_invalidSweepRecipient_self() public {
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidSweepRecipient.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            intent,
            address(ecoSwapGateway)
        );
        vm.stopPrank();
    }

    function test_revert_invalidRewardCreator() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.rewardCreator = address(0);

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidRewardCreator.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    function test_revert_invalidRewardProver() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.rewardProver = address(0);

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidRewardProver.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    // ─── Token & balance assertions ───────────────────────────────

    function test_contractHoldsNoTokensAfter() public {
        _doSwap();
        assertEq(inputToken.balanceOf(address(ecoSwapGateway)), 0);
        assertEq(outputToken.balanceOf(address(ecoSwapGateway)), 0);
    }

    function test_portalApprovalResetToZero() public {
        _doSwap();
        assertEq(outputToken.allowance(address(ecoSwapGateway), address(portal)), 0);
    }

    function test_inputTokenApprovalResetToZero() public {
        _doSwap();
        // Happy-path invariant: the swap's `approve(dex, amount)` and subsequent
        // `transferFrom(amount)` leave zero allowance. The contract does not
        // explicitly reset approvals — this documents that the reference flow
        // naturally terminates with no residue.
        assertEq(inputToken.allowance(address(ecoSwapGateway), address(dex)), 0);
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
        assertEq(inputToken.balanceOf(address(ecoSwapGateway)), 0);
        assertEq(outputToken.balanceOf(address(ecoSwapGateway)), 0);
        assertEq(inputToken.balanceOf(user), userInputBefore - SWAP_AMOUNT);
    }

    function test_sweepsETH() public {
        vm.deal(user, 1 ether);
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        ecoSwapGateway.swapAndCreateIntent{value: 1 ether}(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();

        assertEq(address(ecoSwapGateway).balance, 0);
        assertEq(user.balance, 1 ether);
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

        _doSwap(SWAP_AMOUNT, intent);

        assertEq(outputToken.balanceOf(vault), SWAP_AMOUNT);
        assertEq(outputToken.balanceOf(user), 0);
    }

    // ─── Reentrancy ───────────────────────────────────────────────

    function test_revert_reentrancy() public {
        ReentrantDEX reentrantDex = new ReentrantDEX(
            address(ecoSwapGateway), address(inputToken), address(outputToken)
        );

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(reentrantDex),
            data: abi.encodeWithSelector(ReentrantDEX.swap.selector, SWAP_AMOUNT),
            value: 0
        });

        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert();
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, user
        );
        vm.stopPrank();
    }

    // ─── Call target validation ───────────────────────────────────

    function test_revert_selfCall() public {
        // Self-calls fail via CallFailed wrapping ReentrancyGuardReentrantCall.
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(ecoSwapGateway),
            data: abi.encodeWithSelector(EcoSwapGateway.swapAndCreateIntent.selector),
            value: 0
        });
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert();
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, user
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
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert();
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, user
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
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert();
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, user
        );
        vm.stopPrank();
    }

    function test_revert_emptyCalls() public {
        Call[] memory calls = new Call[](0);
        IntentParams memory intent = _defaultIntentParams();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InsufficientSwapOutput.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), calls, intent, user
        );
        vm.stopPrank();
    }

    // ─── Scalar validation ────────────────────────────────────────

    function test_revert_zeroDenom() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeDenominator = 0;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidScalar.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    function test_revert_zeroNum() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 0;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidScalar.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    function test_revert_numGreaterThanDenom() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1001;
        intent.feeDenominator = 1000;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidScalar.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
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
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InsufficientSwapOutput.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    function test_revert_routeAmountZero() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.feeNumerator = 1;
        intent.feeDenominator = 1;
        intent.flatFee = SWAP_AMOUNT;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RouteAmountZero.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    function test_revert_flatFeeExceedsScaled() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.flatFee = 1_000_000;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RouteAmountZero.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    // ─── Offset errors ────────────────────────────────────────────

    function test_revert_tokensOffsetOutOfBounds() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.tokensAmountOffset = 200;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.OffsetOutOfBounds.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
        );
        vm.stopPrank();
    }

    function test_revert_calldataOffsetOutOfBounds() public {
        IntentParams memory intent = _defaultIntentParams();
        intent.tokensAmountOffset = 32;
        intent.calldataAmountOffset = 200;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.OffsetOutOfBounds.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
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
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RouteAmountZero.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
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
        inputToken.approve(address(ecoSwapGateway), largeAmount);
        vm.expectRevert(IEcoSwapGateway.AmountOverflowU64.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), largeAmount, address(outputToken), _buildSwapCalls(largeAmount), intent, user
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
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.OffsetOutOfBounds.selector);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), SWAP_AMOUNT, address(outputToken), _buildSwapCalls(SWAP_AMOUNT), intent, user
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
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.NativeTransferFailed.selector);
        ecoSwapGateway.swapAndCreateIntent{value: 1 ether}(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            intent,
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
        inputToken.approve(address(ecoSwapGateway), inputAmount);
        ecoSwapGateway.swapAndCreateIntent(
            address(inputToken), inputAmount, address(outputToken), _buildSwapCalls(inputAmount), intent, user
        );
        vm.stopPrank();

        assertEq(outputToken.balanceOf(address(ecoSwapGateway)), 0);
        assertEq(inputToken.balanceOf(address(ecoSwapGateway)), 0);
    }

    // ─── swapAndSelectIntent (bucketed) ───────────────────────────

    function _buildRouteForAmount(uint256 amount) internal pure returns (bytes memory route) {
        route = new bytes(128);
        assembly {
            mstore(add(add(route, 0x20), 32), amount)
            mstore(add(add(route, 0x20), 96), amount)
        }
    }

    function _baseReward() internal view returns (Reward memory reward) {
        TokenAmount[] memory tokens = new TokenAmount[](1);
        tokens[0] = TokenAmount({token: address(outputToken), amount: 0});
        reward = Reward({
            deadline: uint64(block.timestamp + 3600),
            creator: user,
            prover: prover,
            nativeAmount: 0,
            tokens: tokens
        });
    }

    function _baseRewardNative() internal view returns (Reward memory reward) {
        reward = Reward({
            deadline: uint64(block.timestamp + 3600),
            creator: user,
            prover: prover,
            nativeAmount: 0,
            tokens: new TokenAmount[](0)
        });
    }

    function _rewardFor(uint256 amount) internal view returns (Reward memory reward) {
        reward = _baseReward();
        reward.tokens[0].amount = amount;
    }

    function _rewardForNative(uint256 amount) internal view returns (Reward memory reward) {
        reward = _baseRewardNative();
        reward.nativeAmount = amount;
    }

    function _bucketFor(uint256 amount) internal view returns (Bucket memory bucket) {
        bytes memory route = _buildRouteForAmount(amount);
        (, bytes32 routeHash,) = portal.getIntentHash(uint64(1), route, _rewardFor(amount));
        bucket = Bucket({routeHash: routeHash, rewardAmount: amount});
    }

    function _bucketForNative(uint256 amount) internal view returns (Bucket memory bucket) {
        bytes memory route = _buildRouteForAmount(amount);
        (, bytes32 routeHash,) = portal.getIntentHash(uint64(1), route, _rewardForNative(amount));
        bucket = Bucket({routeHash: routeHash, rewardAmount: amount});
    }

    function _doSelect(uint256 amount, Bucket[] memory buckets) internal returns (bytes32) {
        Reward memory baseReward = _baseReward();
        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), amount);
        bytes32 intentHash = ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            amount,
            address(outputToken),
            _buildSwapCalls(amount),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
        return intentHash;
    }

    function test_select_exactFloorMatch() public {
        Bucket[] memory buckets = new Bucket[](3);
        buckets[0] = _bucketFor(500_000);
        buckets[1] = _bucketFor(1_000_000); // matches SWAP_AMOUNT exactly
        buckets[2] = _bucketFor(1_500_000);

        bytes32 intentHash = _doSelect(SWAP_AMOUNT, buckets);
        assertTrue(intentHash != bytes32(0));

        // Vault holds exactly bucket[1].rewardAmount
        bytes memory route = _buildRouteForAmount(1_000_000);
        address vault = portal.intentVaultAddress(1, route, _rewardFor(1_000_000));
        assertEq(outputToken.balanceOf(vault), 1_000_000);
    }

    function test_select_floorBetweenBuckets() public {
        Bucket[] memory buckets = new Bucket[](3);
        buckets[0] = _bucketFor(400_000);
        buckets[1] = _bucketFor(900_000); // floor for swapOutput = 1M
        buckets[2] = _bucketFor(1_200_000);

        _doSelect(SWAP_AMOUNT, buckets);

        bytes memory route = _buildRouteForAmount(900_000);
        address vault = portal.intentVaultAddress(1, route, _rewardFor(900_000));
        assertEq(outputToken.balanceOf(vault), 900_000);
        // Surplus (100_000) goes back to user via sweepRecipient.
        assertEq(outputToken.balanceOf(user), 100_000);
    }

    function test_select_capsAtTopBucket() public {
        Bucket[] memory buckets = new Bucket[](3);
        buckets[0] = _bucketFor(100_000);
        buckets[1] = _bucketFor(200_000);
        buckets[2] = _bucketFor(300_000); // top bucket, well below SWAP_AMOUNT

        _doSelect(SWAP_AMOUNT, buckets);

        bytes memory route = _buildRouteForAmount(300_000);
        address vault = portal.intentVaultAddress(1, route, _rewardFor(300_000));
        assertEq(outputToken.balanceOf(vault), 300_000);
        assertEq(outputToken.balanceOf(user), SWAP_AMOUNT - 300_000);
    }

    function test_select_emitsIntentSelected() public {
        Bucket[] memory buckets = new Bucket[](2);
        buckets[0] = _bucketFor(800_000);
        buckets[1] = _bucketFor(1_000_000);

        Reward memory baseReward = _baseReward();
        bytes32 expectedBucketsHash = keccak256(abi.encode(buckets));

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectEmit(false, true, false, true);
        emit IEcoSwapGateway.IntentSelected(
            bytes32(0), user, SWAP_AMOUNT, 1, 1_000_000, expectedBucketsHash
        );
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_emptyBuckets() public {
        Bucket[] memory buckets = new Bucket[](0);
        Reward memory baseReward = _baseReward();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.EmptyBuckets.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_bucketsNotAscending() public {
        Bucket[] memory buckets = new Bucket[](3);
        buckets[0] = _bucketFor(500_000);
        buckets[1] = _bucketFor(1_000_000);
        buckets[2] = _bucketFor(1_000_000); // equal to previous, not strictly ascending

        Reward memory baseReward = _baseReward();
        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.BucketsNotAscending.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_bucketsDescending() public {
        Bucket[] memory buckets = new Bucket[](2);
        buckets[0] = _bucketFor(1_000_000);
        buckets[1] = _bucketFor(500_000);

        Reward memory baseReward = _baseReward();
        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.BucketsNotAscending.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_belowMinBucket() public {
        Bucket[] memory buckets = new Bucket[](2);
        buckets[0] = _bucketFor(SWAP_AMOUNT + 1); // min is above the swap output
        buckets[1] = _bucketFor(SWAP_AMOUNT + 2);

        Reward memory baseReward = _baseReward();
        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.SwapOutputBelowMinBucket.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_invalidBaseReward_wrongToken() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);

        Reward memory baseReward = _baseReward();
        baseReward.tokens[0].token = address(inputToken); // wrong token

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RewardTokenMismatch.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_invalidBaseReward_nonZeroAmount() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);

        Reward memory baseReward = _baseReward();
        baseReward.tokens[0].amount = 1; // placeholder must be 0

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RewardPlaceholderAmountNotZero.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_invalidBaseReward_nativeAmount() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);

        Reward memory baseReward = _baseReward();
        baseReward.nativeAmount = 1; // must be 0

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RewardNativeAmountNotZero.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_invalidBaseReward_wrongLength() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);

        TokenAmount[] memory tokens = new TokenAmount[](2);
        tokens[0] = TokenAmount({token: address(outputToken), amount: 0});
        tokens[1] = TokenAmount({token: address(outputToken), amount: 0});
        Reward memory baseReward = Reward({
            deadline: uint64(block.timestamp + 3600),
            creator: user,
            prover: prover,
            nativeAmount: 0,
            tokens: tokens
        });

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RewardMustHaveOneToken.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_invalidBaseReward_zeroTokens() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);

        Reward memory baseReward = Reward({
            deadline: uint64(block.timestamp + 3600),
            creator: user,
            prover: prover,
            nativeAmount: 0,
            tokens: new TokenAmount[](0)
        });

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RewardMustHaveOneToken.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_invalidRewardCreator() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);

        Reward memory baseReward = _baseReward();
        baseReward.creator = address(0);

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidRewardCreator.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_invalidRewardProver() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);

        Reward memory baseReward = _baseReward();
        baseReward.prover = address(0);

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidRewardProver.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_select_singleBucket() public {
        // N=1 edge case: floor selection always picks index 0.
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(700_000);

        _doSelect(SWAP_AMOUNT, buckets);

        bytes memory route = _buildRouteForAmount(700_000);
        address vault = portal.intentVaultAddress(1, route, _rewardFor(700_000));
        assertEq(outputToken.balanceOf(vault), 700_000);
        assertEq(outputToken.balanceOf(user), SWAP_AMOUNT - 700_000);
    }

    // ─── Native ETH reward (outputToken == address(0)) ────────────

    function _buildEthOutSwapCalls(MockTokenToETHDEX ethOut, uint256 amount)
        internal
        view
        returns (Call[] memory)
    {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(inputToken),
            data: abi.encodeWithSelector(IERC20.approve.selector, address(ethOut), amount),
            value: 0
        });
        calls[1] = Call({
            target: address(ethOut),
            data: abi.encodeWithSelector(MockTokenToETHDEX.swapForETH.selector, amount),
            value: 0
        });
        return calls;
    }

    function test_select_ethOutput() public {
        MockTokenToETHDEX ethOut = new MockTokenToETHDEX(address(inputToken));
        vm.deal(address(ethOut), 2 ether);

        // Mint extra input so the swap can produce enough ETH to fill buckets.
        uint256 amountIn = 2 ether;
        inputToken.mint(user, amountIn);

        Bucket[] memory buckets = new Bucket[](2);
        buckets[0] = _bucketForNative(0.5 ether);
        buckets[1] = _bucketForNative(1.5 ether); // floor for swapOutput = 2 ETH

        Reward memory baseReward = _baseRewardNative();
        address recipient = makeAddr("ethRecipient");

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), amountIn);
        bytes32 intentHash = ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            amountIn,
            address(0), // native ETH reward
            _buildEthOutSwapCalls(ethOut, amountIn),
            uint64(1),
            baseReward,
            buckets,
            recipient
        );
        vm.stopPrank();

        assertTrue(intentHash != bytes32(0));
        assertEq(address(ecoSwapGateway).balance, 0);
        // Surplus (2 - 1.5 = 0.5 ETH) swept to recipient.
        assertEq(recipient.balance, 0.5 ether);
        // Vault holds exactly the bucket's rewardAmount in ETH.
        bytes memory route = _buildRouteForAmount(1.5 ether);
        address vault = portal.intentVaultAddress(1, route, _rewardForNative(1.5 ether));
        assertEq(vault.balance, 1.5 ether);
    }

    function test_revert_select_nativeReward_hasTokens() public {
        // outputToken = address(0) requires tokens.length == 0.
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketForNative(0.5 ether);

        Reward memory baseReward = _baseReward(); // has a token — wrong for native path

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RewardMustHaveNoTokens.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(0),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_revert_select_nativeReward_nonZeroPlaceholder() public {
        // Native placeholder (nativeAmount) must be 0 before the helper fills it.
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketForNative(0.5 ether);

        Reward memory baseReward = _baseRewardNative();
        baseReward.nativeAmount = 1;

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.RewardPlaceholderAmountNotZero.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(0),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();
    }

    function test_preSwapValidation_emptyBucketsSkipsSwap() public {
        // Bucket structural errors must revert *before* the swap, so the user
        // keeps their input tokens (no DEX slippage eaten).
        Bucket[] memory buckets = new Bucket[](0);
        Reward memory baseReward = _baseReward();

        uint256 userInputBefore = inputToken.balanceOf(user);
        uint256 dexInputBefore = inputToken.balanceOf(address(dex));

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.EmptyBuckets.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();

        assertEq(inputToken.balanceOf(user), userInputBefore);
        assertEq(inputToken.balanceOf(address(dex)), dexInputBefore);
    }

    function test_preSwapValidation_descendingBucketsSkipsSwap() public {
        Bucket[] memory buckets = new Bucket[](2);
        buckets[0] = _bucketFor(1_000_000);
        buckets[1] = _bucketFor(500_000);
        Reward memory baseReward = _baseReward();

        uint256 dexInputBefore = inputToken.balanceOf(address(dex));

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.BucketsNotAscending.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            user
        );
        vm.stopPrank();

        // DEX never received input tokens → swap was not executed.
        assertEq(inputToken.balanceOf(address(dex)), dexInputBefore);
    }

    function test_revert_select_invalidSweepRecipient_self() public {
        Bucket[] memory buckets = new Bucket[](1);
        buckets[0] = _bucketFor(500_000);
        Reward memory baseReward = _baseReward();

        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        vm.expectRevert(IEcoSwapGateway.InvalidSweepRecipient.selector);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            address(ecoSwapGateway)
        );
        vm.stopPrank();
    }

    function test_select_frontRunFundingIsNoOp() public {
        // Third-party funds the selected bucket first.
        // allowPartial=true makes the helper's fund a no-op; user's swap output
        // is swept back rather than stranded.
        Bucket[] memory buckets = new Bucket[](2);
        buckets[0] = _bucketFor(800_000);
        buckets[1] = _bucketFor(1_000_000);

        address frontRunner = makeAddr("frontRunner");
        outputToken.mint(frontRunner, 1_000_000);
        bytes memory route = _buildRouteForAmount(1_000_000);
        Reward memory frontReward = _rewardFor(1_000_000);

        vm.startPrank(frontRunner);
        outputToken.approve(address(portal), 1_000_000);
        portal.fund(uint64(1), keccak256(route), frontReward, false);
        vm.stopPrank();

        uint256 userOutputBefore = outputToken.balanceOf(user);

        _doSelect(SWAP_AMOUNT, buckets);

        // Vault already fully funded by frontRunner.
        address vault = portal.intentVaultAddress(1, route, frontReward);
        assertEq(outputToken.balanceOf(vault), 1_000_000);
        // Helper's 1_000_000 of output token was not consumed; all swept to user.
        assertEq(outputToken.balanceOf(user), userOutputBefore + SWAP_AMOUNT);
        assertEq(outputToken.balanceOf(address(ecoSwapGateway)), 0);
    }

    function test_select_sweepsSurplusToRecipient() public {
        address recipient = makeAddr("sweepRecipient");
        Bucket[] memory buckets = new Bucket[](2);
        buckets[0] = _bucketFor(400_000);
        buckets[1] = _bucketFor(600_000);

        Reward memory baseReward = _baseReward();
        vm.startPrank(user);
        inputToken.approve(address(ecoSwapGateway), SWAP_AMOUNT);
        ecoSwapGateway.swapAndSelectIntent(
            address(inputToken),
            SWAP_AMOUNT,
            address(outputToken),
            _buildSwapCalls(SWAP_AMOUNT),
            uint64(1),
            baseReward,
            buckets,
            recipient
        );
        vm.stopPrank();

        assertEq(outputToken.balanceOf(recipient), SWAP_AMOUNT - 600_000);
        assertEq(outputToken.balanceOf(address(ecoSwapGateway)), 0);
    }
}

/// @notice Helper contract that rejects ETH transfers (no receive/fallback).
contract ETHRejecter {}
