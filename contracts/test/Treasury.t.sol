// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Treasury} from "../src/Treasury.sol";
import {TreasuryTestBase} from "./utils/TreasuryTestBase.sol";

/// @notice Lifecycle and access-control behaviour: who may do what, in which order.
contract TreasuryLifecycleTest is TreasuryTestBase {
    // -----------------------------------------------------------------
    // 1. Policy configuration
    // -----------------------------------------------------------------

    function test_RoleConstantsMatchContract() public view {
        assertEq(treasury.OWNER_ROLE(), ROLE_OWNER, "OWNER_ROLE");
        assertEq(treasury.AGENT_ROLE(), ROLE_AGENT, "AGENT_ROLE");
        assertTrue(treasury.hasRole(ROLE_OWNER, owner), "owner has OWNER_ROLE");
        assertTrue(treasury.hasRole(ROLE_AGENT, agent), "agent has AGENT_ROLE");
        assertFalse(treasury.hasRole(ROLE_OWNER, agent), "agent does NOT have OWNER_ROLE");
        assertFalse(treasury.hasRole(ROLE_AGENT, stranger), "stranger has no roles");
    }

    function test_OwnerCanConfigurePolicy() public {
        _setPolicy(5_000 * UNIT, 20_000 * UNIT, 100_000 * UNIT, 3_000 * UNIT, true);

        (uint256 singleTx, uint256 daily, uint256 monthly, uint256 autoApprove, bool allowUnknown) = treasury.policy();
        assertEq(singleTx, 5_000 * UNIT, "singleTxLimit");
        assertEq(daily, 20_000 * UNIT, "dailyLimit");
        assertEq(monthly, 100_000 * UNIT, "monthlyLimit");
        assertEq(autoApprove, 3_000 * UNIT, "autoApproveLimit");
        assertTrue(allowUnknown, "allowUnknownRecipients");
    }

    function test_PolicyUpdatedEmitsPreviousAndNewValues() public {
        vm.expectEmit(true, true, true, true, address(treasury));
        emit PolicyUpdated(
            P_SINGLE_TX,
            P_DAILY,
            P_MONTHLY,
            P_AUTO_APPROVE,
            P_ALLOW_UNKNOWN,
            5_000 * UNIT,
            20_000 * UNIT,
            100_000 * UNIT,
            3_000 * UNIT,
            true
        );
        _setPolicy(5_000 * UNIT, 20_000 * UNIT, 100_000 * UNIT, 3_000 * UNIT, true);
    }

    // -----------------------------------------------------------------
    // 2. Request creation
    // -----------------------------------------------------------------

    function test_AgentCanCreatePaymentRequest() public {
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, true, true, address(treasury));
        emit PaymentRequested(1, ref, knownA, 800 * UNIT, CAT_MISC, uint8(Treasury.PaymentStatus.AutoApproved));

        vm.prank(agent);
        uint256 id = treasury.createPaymentRequest(knownA, 800 * UNIT, CAT_MISC, ref);

        assertEq(id, 1, "ids start at 1 so 0 means 'unused reference'");
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.AutoApproved), "status");
        assertEq(treasury.referenceToId(ref), id, "referenceToId");
        assertEq(_payment(id).paymentRef, ref, "paymentRef stored");
    }

    function test_StrangerCannotCreatePaymentRequest() public {
        bytes32 ref = _nextRef();
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger, ROLE_AGENT));
        vm.prank(stranger);
        treasury.createPaymentRequest(knownA, 800 * UNIT, CAT_MISC, ref);
    }

    function test_ReusedReferenceReverts() public {
        bytes32 ref = _nextRef();
        vm.prank(agent);
        treasury.createPaymentRequest(knownA, 800 * UNIT, CAT_MISC, ref);

        vm.expectRevert(abi.encodeWithSelector(Treasury.ReferenceAlreadyUsed.selector, ref));
        vm.prank(agent);
        treasury.createPaymentRequest(knownA, 500 * UNIT, CAT_MISC, ref);
    }

    // -----------------------------------------------------------------
    // 3. Allowlist management
    // -----------------------------------------------------------------

    function test_OwnerCanAddAndRemoveRecipient() public {
        vm.expectEmit(true, true, true, true, address(treasury));
        emit RecipientAdded(unknownWallet, CAT_MISC);
        vm.prank(owner);
        treasury.addRecipient(unknownWallet, CAT_MISC);

        (bool approved, bytes32 category,) = treasury.recipients(unknownWallet);
        assertTrue(approved, "approved");
        assertEq(category, CAT_MISC, "category");

        vm.expectEmit(true, true, true, true, address(treasury));
        emit RecipientRemoved(unknownWallet, owner);
        vm.prank(owner);
        treasury.removeRecipient(unknownWallet);

        (bool approvedAfter,,) = treasury.recipients(unknownWallet);
        assertFalse(approvedAfter, "removed");
    }

    function test_SetRecipientApprovedReportsTheChangeNotAnAdd() public {
        // An audit log must not record a de-approval as an "add".
        vm.expectEmit(true, true, true, true, address(treasury));
        emit RecipientApprovalChanged(unknownWallet, true, CAT_MISC);
        vm.prank(owner);
        treasury.setRecipientApproved(unknownWallet, true, CAT_MISC);

        vm.expectEmit(true, true, true, true, address(treasury));
        emit RecipientApprovalChanged(unknownWallet, false, bytes32(0));
        vm.prank(owner);
        treasury.setRecipientApproved(unknownWallet, false, bytes32(0));

        (bool approved,,) = treasury.recipients(unknownWallet);
        assertFalse(approved, "de-approved");
    }

    function test_StrangerCannotAddRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger, ROLE_OWNER));
        vm.prank(stranger);
        treasury.addRecipient(stranger, CAT_MISC);
    }

    function test_StrangerCannotRemoveRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger, ROLE_OWNER));
        vm.prank(stranger);
        treasury.removeRecipient(knownA);
    }

    // -----------------------------------------------------------------
    // 4. Approval authority
    // -----------------------------------------------------------------

    function test_AgentCannotApprovePayment() public {
        uint256 id = _createAsAgent(knownA, 1_500 * UNIT); // above auto-approve -> Pending
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Pending), "precondition: Pending");

        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, agent, ROLE_OWNER));
        vm.prank(agent);
        treasury.approvePayment(id);

        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Pending), "still Pending");
    }

    function test_StrangerCannotApprovePayment() public {
        uint256 id = _createAsAgent(knownA, 1_500 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger, ROLE_OWNER));
        vm.prank(stranger);
        treasury.approvePayment(id);
    }

    function test_OwnerCanApprovePendingPayment() public {
        uint256 id = _createAsAgent(knownA, 1_500 * UNIT);

        vm.expectEmit(true, true, true, true, address(treasury));
        emit PaymentApproved(id, owner, 1_500 * UNIT, _day(), _month());

        vm.prank(owner);
        treasury.approvePayment(id);

        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Approved), "status");
        assertEq(_payment(id).approvedBy, owner, "approvedBy");
        assertEq(treasury.reservedDay(_day()), 1_500 * UNIT, "reservation booked on approval");
    }

    function test_CannotApproveNonPendingPayment() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT); // AutoApproved
        vm.expectRevert(
            abi.encodeWithSelector(Treasury.PaymentNotApprovable.selector, id, Treasury.PaymentStatus.AutoApproved)
        );
        vm.prank(owner);
        treasury.approvePayment(id);
    }

    // -----------------------------------------------------------------
    // 5. THE security-critical rule: authority = f(role, status)
    // -----------------------------------------------------------------

    function test_AgentCanExecuteAutoApprovedPayment() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.AutoApproved), "precondition");

        vm.prank(agent);
        treasury.executePayment(id);

        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Executed), "status");
        assertEq(asset.balanceOf(knownA), 800 * UNIT, "recipient paid");
        assertEq(asset.balanceOf(address(treasury)), TREASURY_BALANCE - 800 * UNIT, "treasury debited");
    }

    function test_AgentCannotExecuteApprovedPayment() public {
        uint256 id = _createAsAgent(knownA, 1_500 * UNIT); // Pending
        vm.prank(owner);
        treasury.approvePayment(id); // -> Approved, requires owner authority to execute
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Approved), "precondition");

        // An agent must NEVER be able to settle a payment that required human approval.
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, agent, ROLE_OWNER));
        vm.prank(agent);
        treasury.executePayment(id);

        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Approved), "unchanged");
        assertEq(asset.balanceOf(knownA), 0, "no funds moved");
    }

    function test_OwnerCanExecuteApprovedPayment() public {
        uint256 id = _createAsAgent(knownA, 1_500 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(id);

        vm.prank(owner);
        treasury.executePayment(id);

        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Executed), "status");
        assertEq(asset.balanceOf(knownA), 1_500 * UNIT, "recipient paid");
    }

    function test_OwnerCanExecuteAutoApprovedPayment() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);
        vm.prank(owner);
        treasury.executePayment(id);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Executed), "status");
    }

    function test_StrangerCannotExecutePayment() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger, ROLE_AGENT));
        vm.prank(stranger);
        treasury.executePayment(id);
    }

    function test_CannotExecutePendingPayment() public {
        uint256 id = _createAsAgent(knownA, 1_500 * UNIT); // Pending
        vm.expectRevert(abi.encodeWithSelector(Treasury.PaymentNotExecutable.selector, id, Treasury.PaymentStatus.Pending));
        vm.prank(owner);
        treasury.executePayment(id);
    }

    function test_CannotExecuteRejectedPayment() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);
        vm.prank(owner);
        treasury.rejectPayment(id, keccak256("no"));

        vm.expectRevert(
            abi.encodeWithSelector(Treasury.PaymentNotExecutable.selector, id, Treasury.PaymentStatus.Rejected)
        );
        vm.prank(owner);
        treasury.executePayment(id);
    }

    function test_BlockedPaymentCanNeverBeApprovedOrExecuted() public {
        uint256 id = _createAsAgent(unknownWallet, 500 * UNIT); // not on the allowlist -> Blocked
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Blocked), "recorded, not reverted");

        vm.expectRevert(
            abi.encodeWithSelector(Treasury.PaymentNotApprovable.selector, id, Treasury.PaymentStatus.Blocked)
        );
        vm.prank(owner);
        treasury.approvePayment(id);

        vm.expectRevert(
            abi.encodeWithSelector(Treasury.PaymentNotExecutable.selector, id, Treasury.PaymentStatus.Blocked)
        );
        vm.prank(agent);
        treasury.executePayment(id);
    }

    function test_ExecutedPaymentCannotExecuteAgain() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);
        vm.prank(agent);
        treasury.executePayment(id);

        vm.expectRevert(
            abi.encodeWithSelector(Treasury.PaymentNotExecutable.selector, id, Treasury.PaymentStatus.Executed)
        );
        vm.prank(agent);
        treasury.executePayment(id);

        assertEq(asset.balanceOf(knownA), 800 * UNIT, "recipient paid exactly once");
    }

    function test_BlockedRequestIsAuditableAndPermanent() public {
        bytes32 ref = _nextRef();
        vm.expectEmit(true, true, false, true, address(treasury));
        emit PaymentBlocked(1, unknownWallet, 8_000 * UNIT, uint16(Treasury.ReasonCode.UnknownRecipient));

        vm.prank(agent);
        uint256 id = treasury.createPaymentRequest(unknownWallet, 8_000 * UNIT, CAT_MISC, ref);

        // The attempt has an id, a reference, and an on-chain record.
        assertEq(id, 1, "id issued for an auditable attempt");
        assertEq(treasury.referenceToId(ref), id, "reference resolvable");
    }

    // -----------------------------------------------------------------
    // 6. Rejection
    // -----------------------------------------------------------------

    function test_OwnerCanRejectAndReservationIsReleased() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT); // AutoApproved -> reserved
        assertEq(treasury.reservedDay(_day()), 800 * UNIT, "reserved");

        vm.expectEmit(true, true, false, true, address(treasury));
        emit PaymentRejected(id, owner, keccak256("not now"), 800 * UNIT, _day(), _month());

        vm.prank(owner);
        treasury.rejectPayment(id, keccak256("not now"));

        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Rejected), "status");
        assertEq(treasury.reservedDay(_day()), 0, "day reservation released");
        assertEq(treasury.lifetimeReserved(), 0, "lifetime released");
    }

    function test_AgentCannotRejectPayment() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, agent, ROLE_OWNER));
        vm.prank(agent);
        treasury.rejectPayment(id, keccak256("x"));
    }

    // -----------------------------------------------------------------
    // 7. Pause
    // -----------------------------------------------------------------

    function test_PausedTreasuryBlocksExecution() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);

        vm.prank(owner);
        treasury.pause();
        assertTrue(treasury.paused(), "paused");

        vm.expectRevert(); // EnforcedPause from OZ Pausable
        vm.prank(agent);
        treasury.executePayment(id);

        assertEq(asset.balanceOf(knownA), 0, "no funds moved");
    }

    function test_UnpausingRestoresExecution() public {
        uint256 id = _createAsAgent(knownA, 800 * UNIT);

        vm.prank(owner);
        treasury.pause();
        vm.prank(owner);
        treasury.unpause();
        assertFalse(treasury.paused(), "unpaused");

        vm.prank(agent);
        treasury.executePayment(id);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Executed), "status");
    }

    function test_AgentCannotPause() public {
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, agent, ROLE_OWNER));
        vm.prank(agent);
        treasury.pause();
    }

    // -----------------------------------------------------------------
    // 8. canExecute mirrors executePayment
    // -----------------------------------------------------------------

    function test_CanExecuteAgreesWithExecuteForAgentAndApprovedPayment() public {
        uint256 id = _createAsAgent(knownA, 1_500 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(id);

        (bool agentAllowed, uint16 agentReason) = treasury.canExecute(id, agent);
        assertFalse(agentAllowed, "agent may not execute APPROVED");
        assertEq(agentReason, uint16(Treasury.ReasonCode.CallerNotAuthorized), "reason");

        (bool ownerAllowed, uint16 ownerReason) = treasury.canExecute(id, owner);
        assertTrue(ownerAllowed, "owner may execute APPROVED");
        assertEq(ownerReason, uint16(Treasury.ReasonCode.None), "reason");

        // The view is not a lie: the actual call fails exactly as predicted.
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, agent, ROLE_OWNER));
        vm.prank(agent);
        treasury.executePayment(id);
    }
}
