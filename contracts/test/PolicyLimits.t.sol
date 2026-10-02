// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Treasury} from "../src/Treasury.sol";
import {TreasuryTestBase} from "./utils/TreasuryTestBase.sol";

/// @notice Policy limits and the reserved/settled accounting that backs them.
/// @dev These are the tests that justify the contract existing. A treasury that merely
///      *documents* limits is a suggestion; these assert it re-derives and enforces them.
contract PolicyLimitsTest is TreasuryTestBase {
    // -----------------------------------------------------------------
    // 1. `0 = unlimited` must never be read as "tightest possible"
    // -----------------------------------------------------------------

    function test_ZeroLimitsMeanUnlimited() public {
        // singleTxLimit and dailyLimit unlimited; auto-approval disabled (0 there means OFF).
        _setPolicy(0, 0, P_MONTHLY, 0, false);

        (bool allowed, uint16 reason) = treasury.evaluatePayment(knownA, 25_000 * UNIT);
        assertTrue(allowed, "25k is allowed under an unlimited single-tx limit");
        assertEq(reason, uint16(Treasury.ReasonCode.None), "reason");

        uint256 id = _createAsAgent(knownA, 25_000 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Pending), "auto-approval disabled");
    }

    function test_ZeroAutoApproveLimitDisablesAutoApproval() public {
        _setPolicy(P_SINGLE_TX, P_DAILY, P_MONTHLY, 0, false);
        uint256 id = _createAsAgent(knownA, 1 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Pending), "tiny amount still not auto-approved");
    }

    function test_UnlimitedSingleTxIsValidAlongsideAutoApproveLimit() public {
        // The documented valid combination: singleTx unlimited, daily bounded, auto-approve 5k.
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 5_000 * UNIT, false);
        uint256 id = _createAsAgent(knownA, 4_000 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.AutoApproved), "auto-approved");
    }

    function test_AutoApproveLimitAboveSingleTxLimitIsRejected() public {
        vm.expectRevert(Treasury.InvalidPolicyConfiguration.selector);
        _setPolicy(1_000 * UNIT, P_DAILY, P_MONTHLY, 2_000 * UNIT, false);
    }

    function test_DailyAboveMonthlyIsRejected() public {
        vm.expectRevert(Treasury.InvalidPolicyConfiguration.selector);
        _setPolicy(P_SINGLE_TX, 100_000 * UNIT, 50_000 * UNIT, P_AUTO_APPROVE, false);
    }

    // -----------------------------------------------------------------
    // 2. Per-payment policy gates produce BLOCKED with a reason code
    // -----------------------------------------------------------------

    function test_AmountAboveSingleTxLimitIsBlocked() public {
        (uint256 id, uint16 reason) = _createAndReadBlockReason(knownA, 2_001 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Blocked), "Blocked");
        assertEq(reason, uint16(Treasury.ReasonCode.SingleTxLimit), "reason");
    }

    function test_UnknownRecipientIsBlockedButAllowableViaPolicy() public {
        (uint256 id, uint16 reason) = _createAndReadBlockReason(unknownWallet, 500 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Blocked), "Blocked");
        assertEq(reason, uint16(Treasury.ReasonCode.UnknownRecipient), "reason");

        _setPolicy(P_SINGLE_TX, P_DAILY, P_MONTHLY, P_AUTO_APPROVE, true);
        uint256 id2 = _createAsAgent(unknownWallet, 500 * UNIT);
        assertEq(uint8(_status(id2)), uint8(Treasury.PaymentStatus.AutoApproved), "allowed once policy permits");
    }

    function test_SelfTransferIsBlocked() public {
        (uint256 id, uint16 reason) = _createAndReadBlockReason(address(treasury), 500 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Blocked), "Blocked");
        assertEq(reason, uint16(Treasury.ReasonCode.SelfTransfer), "reason");
    }

    function test_AmountBeyondBalanceIsBlocked() public {
        // single-tx unbounded, so the balance check is the one that fires.
        _setPolicy(0, P_DAILY, P_MONTHLY, P_AUTO_APPROVE, false);
        (uint256 id, uint16 reason) = _createAndReadBlockReason(knownA, 60_000 * UNIT); // treasury holds 50k
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Blocked), "Blocked");
        assertEq(reason, uint16(Treasury.ReasonCode.InsufficientBalance), "reason");
    }

    function test_ZeroReferenceReverts() public {
        vm.expectRevert(Treasury.InvalidReference.selector);
        vm.prank(agent);
        treasury.createPaymentRequest(knownA, 500 * UNIT, CAT_MISC, bytes32(0));
    }

    // -----------------------------------------------------------------
    // 3. Period limits
    // -----------------------------------------------------------------

    function test_DailyLimitBlocksTheOverCommittingRequest() public {
        // Auto-approval is high enough that the 6k request WOULD auto-approve, so the only
        // reason the second one is refused is the daily budget.
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 6_000 * UNIT, false);

        uint256 first = _createAsAgent(knownA, 6_000 * UNIT);
        (uint256 second, uint16 reason) = _createAndReadBlockReason(knownB, 6_000 * UNIT);

        assertEq(uint8(_status(first)), uint8(Treasury.PaymentStatus.AutoApproved), "first reserved");
        assertEq(uint8(_status(second)), uint8(Treasury.PaymentStatus.Blocked), "second blocked");
        assertEq(reason, uint16(Treasury.ReasonCode.DailyLimit), "reason");
    }

    function test_ReservationAndSpendingShareOneDailyBudget() public {
        // The daily cap is on committed + settled TOGETHER, not on each counter independently.
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);

        uint256 id = _createAsAgent(knownA, 10_000 * UNIT); // Pending (auto-approve off)
        vm.prank(owner);
        treasury.approvePayment(id);
        assertEq(treasury.reservedDay(_day()), 10_000 * UNIT, "full budget reserved");

        vm.prank(owner);
        treasury.executePayment(id);

        // Settlement moves the same 10k from `reserved` to `spent`: the day's total is unchanged,
        // so a second payment must still be refused.
        assertEq(treasury.reservedDay(_day()), 0, "reservation released");
        assertEq(treasury.spentDay(_day()), 10_000 * UNIT, "recorded as spent");

        (uint256 second, uint16 reason) = _createAndReadBlockReason(knownB, 1 * UNIT);
        assertEq(uint8(_status(second)), uint8(Treasury.PaymentStatus.Blocked), "no new headroom from settling");
        assertEq(reason, uint16(Treasury.ReasonCode.DailyLimit), "reason");
    }

    function test_MonthlyLimitBlocksAcrossDaysInTheSameMonth() public {
        // 2k/day, 3k/month. The test timestamp is 2026-09-01, so three days of 1k land on
        // Sep 1-3 and exhaust the month while leaving each day's budget half unused.
        _setPolicy(P_SINGLE_TX, 2_000 * UNIT, 3_000 * UNIT, 1_000 * UNIT, false);

        for (uint256 i = 0; i < 3; i++) {
            uint256 id = _createAsAgent(knownA, 1_000 * UNIT);
            assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.AutoApproved), "auto-approved");
            vm.prank(agent);
            treasury.executePayment(id);
            if (i < 2) vm.warp(block.timestamp + 1 days);
        }
        assertEq(_month(), treasury.currentMonthKey(), "still the same month");

        // A fourth day of spending is refused even though the DAY budget is untouched, because
        // the month budget is gone. This is exactly the distinction the two counters exist for.
        uint256 overflow;
        uint16 reason;
        (overflow, reason) = _createAndReadBlockReason(knownA, 1_000 * UNIT);
        assertEq(uint8(_status(overflow)), uint8(Treasury.PaymentStatus.Blocked), "month exhausted");
        assertEq(reason, uint16(Treasury.ReasonCode.MonthlyLimit), "reason");
    }

    function test_NewMonthResetsTheMonthlyBudgetButNotTheDay() public {
        _setPolicy(P_SINGLE_TX, 1_000 * UNIT, 1_000 * UNIT, 1_000 * UNIT, false);

        uint256 id = _createAsAgent(knownA, 1_000 * UNIT);
        vm.prank(agent);
        treasury.executePayment(id);

        // BASE_TIME is 2026-09-01, so this crosses into October.
        vm.warp(block.timestamp + 35 days);
        (uint16 year, uint8 month) = treasury.currentYearMonth();
        assertEq(year, 2026, "year");
        assertEq(month, 10, "October");

        uint256 next = _createAsAgent(knownA, 1_000 * UNIT);
        assertEq(uint8(_status(next)), uint8(Treasury.PaymentStatus.AutoApproved), "fresh month budget");
    }

    // -----------------------------------------------------------------
    // 4. THE bypass this design exists to prevent
    // -----------------------------------------------------------------

    function test_ReservationParkedAcrossADayBoundaryCannotStackTwoDaysOfBudget() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);

        // Day 1: reserve 6k by approving a payment. It stays unexecuted.
        uint256 p1 = _createAsAgent(knownA, 6_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);
        uint256 day1 = _day();
        assertEq(treasury.reservedDay(day1), 6_000 * UNIT, "reserved on day 1");

        // Day 2: a fresh payment consumes 6k of day 2's budget.
        vm.warp(block.timestamp + 1 days);
        uint256 day2 = _day();
        assertTrue(day2 > day1, "really a new UTC day");

        uint256 p2 = _createAsAgent(knownB, 6_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p2);
        assertEq(treasury.reservedDay(day2), 6_000 * UNIT, "day 2 has its own reservation");

        // Day 2 would carry 6k reserved + 6k spent = 12k against a 10k limit. This must revert.
        vm.expectRevert(abi.encodeWithSelector(Treasury.PolicyViolation.selector, uint16(Treasury.ReasonCode.DailyLimit), 10_000 * UNIT, 12_000 * UNIT));
        vm.prank(owner);
        treasury.executePayment(p1);

        assertEq(uint8(_status(p1)), uint8(Treasury.PaymentStatus.Approved), "p1 untouched");
        assertEq(asset.balanceOf(knownA), 0, "no funds moved");
        assertEq(treasury.reservedDay(day1), 6_000 * UNIT, "day 1 reservation intact");
    }

    function test_SameDaySettlementStillWorks() public {
        // The guard above must not break the ordinary path: reserve and settle on one day.
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownA, 6_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);
        vm.prank(owner);
        treasury.executePayment(p1);
        assertEq(uint8(_status(p1)), uint8(Treasury.PaymentStatus.Executed), "executed same day");
    }

    // -----------------------------------------------------------------
    // 5. Policy lowering strands reservations (intentional fail-safe)
    // -----------------------------------------------------------------

    function test_LoweringTheDailyLimitStrandsAnExistingReservation() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownA, 6_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);

        // Owner tightens the daily cap below the outstanding reservation.
        _setPolicy(0, 1_000 * UNIT, P_MONTHLY, 0, false);

        (bool allowed, uint16 reason) = treasury.canExecute(p1, owner);
        assertFalse(allowed, "execution refused");
        assertEq(reason, uint16(Treasury.ReasonCode.DailyLimit), "reason reported");

        vm.expectRevert(abi.encodeWithSelector(Treasury.PolicyViolation.selector, uint16(Treasury.ReasonCode.DailyLimit), 1_000 * UNIT, 6_000 * UNIT));
        vm.prank(owner);
        treasury.executePayment(p1);

        // The only documented cures: raise the limit back, or reject to release.
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        vm.prank(owner);
        treasury.executePayment(p1);
        assertEq(uint8(_status(p1)), uint8(Treasury.PaymentStatus.Executed), "unblocked by raising the limit");
    }

    function test_RejectIsTheEscapeFromAStrandedReservation() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownA, 6_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);

        _setPolicy(0, 1_000 * UNIT, P_MONTHLY, 0, false);
        vm.prank(owner);
        treasury.rejectPayment(p1, keccak256("budget cut"));

        assertEq(treasury.reservedDay(_day()), 0, "reservation released");
        assertEq(treasury.lifetimeReserved(), 0, "lifetime reservation unwound");

        // The freed budget is genuinely usable again.
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p2 = _createAsAgent(knownB, 6_000 * UNIT);
        assertEq(uint8(_status(p2)), uint8(Treasury.PaymentStatus.Pending), "rejected attempt left no ghost budget");
        vm.prank(owner);
        treasury.approvePayment(p2);
        assertEq(uint8(_status(p2)), uint8(Treasury.PaymentStatus.Approved), "re-approvable");
    }

    // -----------------------------------------------------------------
    // 6. Rejection must unwind the ORIGINAL bucket, not today's
    // -----------------------------------------------------------------

    function test_RejectionAfterDayRolloverReleasesTheOriginalBucket() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownA, 6_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);
        uint256 originalDay = _day();

        vm.warp(block.timestamp + 1 days);
        assertTrue(_day() > originalDay, "day changed");

        // On a later day: day 1 must lose 6k, today must be untouched.
        vm.prank(owner);
        treasury.rejectPayment(p1, keccak256("obsolete"));

        assertEq(treasury.reservedDay(originalDay), 0, "original bucket released");
        assertEq(treasury.reservedDay(_day()), 0, "today's bucket never debited");
        assertEq(treasury.lifetimeReserved(), 0, "lifetime balanced");
    }

    function test_RejectionAfterMonthRolloverReleasesTheOriginalMonthBucket() public {
        _setPolicy(0, 10_000 * UNIT, 10_000 * UNIT, 0, false);
        uint256 p1 = _createAsAgent(knownA, 6_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);
        uint256 originalMonth = _month();

        vm.warp(block.timestamp + 40 days); // crosses a month boundary
        assertTrue(_month() > originalMonth, "month changed");

        vm.prank(owner);
        treasury.rejectPayment(p1, keccak256("obsolete"));

        assertEq(treasury.reservedMonth(originalMonth), 0, "original month released");
        assertEq(treasury.reservedMonth(_month()), 0, "current month untouched");
    }

    // -----------------------------------------------------------------
    // 7. TOCTOU: policy is re-derived at execution, not trusted from creation
    // -----------------------------------------------------------------

    function test_PolicyChangeBetweenCreationAndExecutionIsCaught() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownA, 1_500 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);

        // Tighten single-tx below the already-approved amount.
        _setPolicy(1_000 * UNIT, 10_000 * UNIT, P_MONTHLY, 0, false);

        vm.expectRevert(abi.encodeWithSelector(Treasury.PolicyViolation.selector, uint16(Treasury.ReasonCode.SingleTxLimit), 1_000 * UNIT, 1_500 * UNIT));
        vm.prank(owner);
        treasury.executePayment(p1);
    }

    function test_RecipientRemovedFromAllowlistBeforeExecutionBlocksSettlement() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownB, 1_500 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);

        vm.prank(owner);
        treasury.removeRecipient(knownB);

        vm.expectRevert(abi.encodeWithSelector(Treasury.PolicyViolation.selector, uint16(Treasury.ReasonCode.UnknownRecipient), 0, 1_500 * UNIT));
        vm.prank(owner);
        treasury.executePayment(p1);
    }

    function test_TwoApprovalsCannotBothPassTheSameDailyBudget() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);

        // Six 2k requests all created while the budget is free; none is reserved yet, because
        // auto-approval is off. Nothing is committed until an approval actually books it.
        uint256[6] memory ids;
        for (uint256 i = 0; i < 6; i++) {
            ids[i] = _createAsAgent(knownA, 2_000 * UNIT);
            assertEq(uint8(_status(ids[i])), uint8(Treasury.PaymentStatus.Pending), "pending, not reserved");
        }
        assertEq(treasury.reservedDay(_day()), 0, "creation reserves nothing");

        // Five approvals fill the day exactly. The limit is inclusive, so this is legal.
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(owner);
            treasury.approvePayment(ids[i]);
        }
        assertEq(treasury.reservedDay(_day()), 10_000 * UNIT, "5 x 2k = exactly the cap");

        // The sixth would be the 11th k. Each approval re-derives the totals from storage, so a
        // batch of approvals cannot collectively over-commit even though every single one of
        // them was individually acceptable when it was created.
        vm.expectRevert(abi.encodeWithSelector(Treasury.PolicyViolation.selector, uint16(Treasury.ReasonCode.DailyLimit), 10_000 * UNIT, 12_000 * UNIT));
        vm.prank(owner);
        treasury.approvePayment(ids[5]);

        assertEq(treasury.reservedDay(_day()), 10_000 * UNIT, "unchanged");
        assertEq(uint8(_status(ids[5])), uint8(Treasury.PaymentStatus.Pending), "still pending");
    }

    // -----------------------------------------------------------------
    // 8. Views that must not lie
    // -----------------------------------------------------------------

    function test_EvaluatePaymentAgreesWithWhatCreationActuallyDoes() public {
        (bool allowed, uint16 reason) = treasury.evaluatePayment(unknownWallet, 5_000 * UNIT);
        assertFalse(allowed, "unknown recipient");
        assertEq(reason, uint16(Treasury.ReasonCode.UnknownRecipient), "reason");

        uint256 id = _createAsAgent(unknownWallet, 5_000 * UNIT);
        assertEq(uint8(_status(id)), uint8(Treasury.PaymentStatus.Blocked), "preview matches outcome");
    }

    function test_HeadroomAccountsForReservedAndSpentTogether() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownA, 4_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);

        (uint256 singleTxRemaining, uint256 dayRemaining, uint256 monthRemaining) = treasury.previewHeadroom();
        assertEq(singleTxRemaining, type(uint256).max, "single tx unlimited in this policy");
        assertEq(dayRemaining, 6_000 * UNIT, "day headroom after 4k reserved");
        assertEq(monthRemaining, P_MONTHLY - 4_000 * UNIT, "month headroom");

        vm.prank(owner);
        treasury.executePayment(p1);
        (, uint256 dayAfter,) = treasury.previewHeadroom();
        assertEq(dayAfter, 6_000 * UNIT, "settling does not create headroom");
    }

    function test_UnlimitedLimitsReportMaxHeadroom() public {
        _setPolicy(0, 0, 0, 0, false);
        (uint256 singleTxRemaining, uint256 dayRemaining, uint256 monthRemaining) = treasury.previewHeadroom();
        assertEq(singleTxRemaining, type(uint256).max, "single");
        assertEq(dayRemaining, type(uint256).max, "day");
        assertEq(monthRemaining, type(uint256).max, "month");
    }

    function test_HasUnboundedAutoApprovalFlagsTheDangerousCombination() public {
        _setPolicy(0, 0, P_MONTHLY, 5_000 * UNIT, false);
        assertTrue(treasury.hasUnboundedAutoApproval(), "unbounded within the day");

        _setPolicy(2_000 * UNIT, 0, P_MONTHLY, 1_000 * UNIT, false);
        assertFalse(treasury.hasUnboundedAutoApproval(), "single-tx bound applies");
    }

    function test_CurrentUsageReportsReservedPlusSpent() public {
        _setPolicy(0, 10_000 * UNIT, P_MONTHLY, 0, false);
        uint256 p1 = _createAsAgent(knownA, 4_000 * UNIT);
        vm.prank(owner);
        treasury.approvePayment(p1);
        (uint256 dayCommitted,) = treasury.currentUsage();
        assertEq(dayCommitted, 4_000 * UNIT, "reserved counts as committed");

        vm.prank(owner);
        treasury.executePayment(p1);
        (uint256 dayAfter,) = treasury.currentUsage();
        assertEq(dayAfter, 4_000 * UNIT, "still committed, now as spent");
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------
}
