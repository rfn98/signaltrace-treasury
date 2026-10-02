// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Vm} from "forge-std/Vm.sol";

import {Treasury} from "../src/Treasury.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {TreasuryTestBase} from "./utils/TreasuryTestBase.sol";

/// @dev An ERC20 that calls back into the treasury from inside `transfer`, i.e. at the one
///      point where `Treasury.executePayment` has already written its effects. Only this can
///      observe whether the guard actually holds.
contract ReentrantToken is ERC20 {
    Treasury public target;
    uint256 public reenterId;
    bool public attackEnabled;
    uint256 public callbackCount;

    constructor() ERC20("Reentrant", "REENT") {}

    /// @dev Settable rather than immutable so the token can be deployed before the treasury that
    ///      holds it, which is the only order the treasury's constructor permits.
    function setTarget(Treasury target_) external {
        target = target_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(uint256 id) external {
        reenterId = id;
        attackEnabled = true;
    }

    function disarm() external {
        attackEnabled = false;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (attackEnabled) {
            // Try to settle the same payment again from inside the settlement.
            callbackCount += 1;
            target.executePayment(reenterId);
        }
        return super.transfer(to, value);
    }
}

contract SecurityTest is TreasuryTestBase {
    uint256 internal constant AMOUNT = 800 * UNIT;

    // -----------------------------------------------------------------
    // 1. Reentrancy
    // -----------------------------------------------------------------

    function test_ReentrantTokenCannotDoubleSpendAPayment() public {
        ReentrantToken evil = new ReentrantToken();
        Treasury t = new Treasury(IERC20(address(evil)), owner, agent);
        evil.setTarget(t);
        _bootstrap(t);
        evil.mint(address(t), 50_000 * UNIT);

        vm.prank(agent);
        uint256 id = t.createPaymentRequest(knownA, AMOUNT, CAT_MISC, _nextRef());
        assertEq(uint8(t.getPayment(id).status), uint8(Treasury.PaymentStatus.AutoApproved), "auto-approved");

        evil.arm(id);

        // The outer call writes every effect, then hands control to the token. The token calls
        // `executePayment` again for the same id from inside `transfer`; `nonReentrant` reverts
        // the inner call, and because the token does not catch it the whole transaction reverts
        // with the guard's own error bubbling up through `safeTransfer`.
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(agent);
        t.executePayment(id);

        // The failed attempt moved nothing, and the payment is untouched: still executable.
        // `callbackCount` reads 0 because the increment was itself rolled back — the revert
        // unwound the entire transaction, not just the inner call.
        assertEq(evil.balanceOf(knownA), 0, "nothing settled");
        assertEq(evil.callbackCount(), 0, "no state survived the revert");
        assertEq(uint8(t.getPayment(id).status), uint8(Treasury.PaymentStatus.AutoApproved), "still auto-approved");

        // Disarm and settle for real: exactly one payment moves, once.
        evil.disarm();
        vm.prank(agent);
        t.executePayment(id);
        assertEq(evil.balanceOf(knownA), AMOUNT, "recipient paid exactly once");
        assertEq(evil.balanceOf(address(t)), 50_000 * UNIT - AMOUNT, "treasury debited once");
        assertEq(uint8(t.getPayment(id).status), uint8(Treasury.PaymentStatus.Executed), "executed");
    }

    function test_ReentrancyGuardIsArmedOnlyForTheDurationOfTheCall() public {
        ReentrantToken evil = new ReentrantToken();
        Treasury t = new Treasury(IERC20(address(evil)), owner, agent);
        evil.setTarget(t);
        _bootstrap(t);
        evil.mint(address(t), 50_000 * UNIT);

        // No reentrancy armed: this must simply work.
        vm.prank(agent);
        uint256 id = t.createPaymentRequest(knownA, AMOUNT, CAT_MISC, _nextRef());
        vm.prank(agent);
        t.executePayment(id);
        assertEq(evil.balanceOf(knownA), AMOUNT, "settled");
        assertEq(evil.callbackCount(), 0, "no callbacks attempted");
    }

    // -----------------------------------------------------------------
    // 2. The treasury holds no ETH and exposes no approval surface
    // -----------------------------------------------------------------

    function test_TreasuryHoldsNoEth() public {
        vm.deal(address(treasury), 1 ether);
        uint256 id = _createAsAgent(knownA, AMOUNT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.AutoApproved), "auto-approved");

        // Settling must move only the token. The ether balance is untouched.
        vm.prank(agent);
        treasury.executePayment(id);
        assertEq(address(treasury).balance, 1 ether, "no ETH left the treasury");
        assertEq(asset.balanceOf(knownA), AMOUNT, "only the token moved");
    }

    /// @dev The test above proves settlement never *touches* ETH, but it forces the ETH in with
    ///      `vm.deal`, which says nothing about whether the contract would accept a transfer in
    ///      the first place. It has no `receive` and no `fallback`, so a plain transfer must
    ///      revert. Without this, a stray `receive() external payable {}` added later would let
    ///      anyone inflate the balance unnoticed.
    function test_PlainEthTransferIsRejected() public {
        (bool ok,) = address(treasury).call{value: 1 ether}("");
        assertFalse(ok, "treasury has no receive/fallback: a plain transfer must revert");

        assertEq(address(treasury).balance, 0, "no ETH was accepted");
    }

    /// @dev None of the entry points may be payable either, so ETH cannot ride in with a call.
    function test_EthIsRejectedAlongsideARealCall() public {
        bytes memory data = abi.encodeCall(Treasury.fund, (1 ether));

        (bool ok,) = address(treasury).call{value: 1 ether}(data);
        assertFalse(ok, "fund is not payable: value must be rejected");
        assertEq(asset.balanceOf(address(treasury)), TREASURY_BALANCE, "no tokens moved either");

        assertEq(address(treasury).balance, 0, "no ETH was accepted");
    }

    function test_FundPullsTokensAndEmitsFunded() public {
        // `fund` is OWNER_ROLE-only by design: a treasury does not accept an unaudited top-up
        // from an arbitrary address, because that would make the balance an attacker-controlled
        // input to a policy decision.
        asset.mint(owner, 5_000 * UNIT);
        vm.prank(owner);
        asset.approve(address(treasury), 5_000 * UNIT);

        vm.expectEmit(true, true, true, true, address(treasury));
        emit Funded(owner, 5_000 * UNIT);

        vm.prank(owner);
        treasury.fund(5_000 * UNIT);
        assertEq(asset.balanceOf(address(treasury)), TREASURY_BALANCE + 5_000 * UNIT, "funded");
    }

    function test_StrangerCannotFund() public {
        asset.mint(stranger, 1_000 * UNIT);
        vm.startPrank(stranger);
        asset.approve(address(treasury), 1_000 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger, ROLE_OWNER));
        treasury.fund(1_000 * UNIT);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // 3. Access-control housekeeping
    // -----------------------------------------------------------------

    function test_LastAdminCannotBeRemoved() public {
        // Read the role id first: `DEFAULT_ADMIN_ROLE()` is itself a call, and evaluating it
        // inside an `expectRevert` window would consume the expectation.
        bytes32 admin = treasury.DEFAULT_ADMIN_ROLE();
        assertEq(treasury.adminCount(), 1, "one admin");

        vm.expectRevert(Treasury.LastAdmin.selector);
        vm.prank(owner);
        treasury.revokeRole(admin, owner);
    }

    function test_LastAdminCannotRenounce() public {
        bytes32 admin = treasury.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(Treasury.LastAdmin.selector);
        vm.prank(owner);
        treasury.renounceRole(admin, owner);
    }

    function test_LastAdminGuardAllowsTheRoleOnceASecondAdminExists() public {
        bytes32 admin = treasury.DEFAULT_ADMIN_ROLE();

        vm.prank(owner);
        treasury.grantRole(admin, stranger);
        assertEq(treasury.adminCount(), 2, "two admins");

        // The role's own admin revokes it; the grantee cannot.
        vm.prank(owner);
        treasury.revokeRole(admin, stranger);
        assertEq(treasury.adminCount(), 1, "back to one");
    }

    function test_OwnerRoleRemovalLocksTheOwnerOut() public {
        vm.startPrank(owner);
        treasury.revokeRole(ROLE_OWNER, owner);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, owner, ROLE_OWNER));
        vm.prank(owner);
        treasury.setPolicy(
            Treasury.Policy({singleTxLimit: 1, dailyLimit: 1, monthlyLimit: 1, autoApproveLimit: 1, allowUnknownRecipients: false})
        );
    }

    // -----------------------------------------------------------------
    // 4. Constructor hygiene
    // -----------------------------------------------------------------

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(Treasury.ZeroAddress.selector);
        new Treasury(IERC20(address(asset)), address(0), agent);

        vm.expectRevert(Treasury.ZeroAddress.selector);
        new Treasury(IERC20(address(asset)), owner, address(0));

        vm.expectRevert(Treasury.ZeroAddress.selector);
        new Treasury(IERC20(address(0)), owner, agent);
    }

    function test_ConstructorSnapshotsTheAssetDecimals() public view {
        assertEq(treasury.assetDecimals(), 6, "MockERC20 is 6dp");
        assertEq(address(treasury.asset()), address(asset), "asset");
    }

    // -----------------------------------------------------------------
    // 5. Not-found and view guards
    // -----------------------------------------------------------------

    function test_UnknownPaymentIdIsRejectedEverywhere() public {
        vm.expectRevert(abi.encodeWithSelector(Treasury.PaymentNotFound.selector, uint256(0)));
        treasury.getPayment(0);

        vm.expectRevert(abi.encodeWithSelector(Treasury.PaymentNotFound.selector, uint256(99)));
        vm.prank(owner);
        treasury.approvePayment(99);

        vm.expectRevert(abi.encodeWithSelector(Treasury.PaymentNotFound.selector, uint256(99)));
        vm.prank(agent);
        treasury.executePayment(99);
    }

    function test_SelfRecipientCannotBeAllowlisted() public {
        vm.expectRevert(Treasury.InvalidRecipient.selector);
        vm.prank(owner);
        treasury.addRecipient(address(treasury), CAT_MISC);
    }

    function test_RemoveRecipientRequiresItToExist() public {
        vm.expectRevert(Treasury.InvalidRecipient.selector);
        vm.prank(owner);
        treasury.removeRecipient(unknownWallet);
    }

    // -----------------------------------------------------------------
    // 6. Flat events: the shape viem decodes
    // -----------------------------------------------------------------

    function test_EventsCarryOnlyFlatPrimitives() public {
        vm.recordLogs();
        uint256 id = _createAsAgent(knownA, AMOUNT);
        vm.prank(agent);
        treasury.executePayment(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertGt(logs.length, 0, "logs emitted");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].data.length % 32 == 0, "data is a whole number of words");
            assertTrue(logs[i].topics.length >= 1, "carries a topic");
        }
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    /// @dev Give a second treasury the same policy and allowlist as the main fixture. Funding
    ///      is the caller's job because the token type differs.
    function _bootstrap(Treasury t) internal {
        Treasury.Policy memory p = Treasury.Policy({
            singleTxLimit: 0,
            dailyLimit: 0,
            monthlyLimit: P_MONTHLY,
            autoApproveLimit: P_AUTO_APPROVE,
            allowUnknownRecipients: false
        });
        vm.prank(owner);
        t.setPolicy(p);
        vm.startPrank(owner);
        t.addRecipient(knownA, CAT_CLOUD);
        t.addRecipient(knownB, CAT_CONTRACTOR);
        vm.stopPrank();
    }
}
