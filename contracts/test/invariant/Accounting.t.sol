// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Treasury} from "../../src/Treasury.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @notice Values shared by the handler and the test, in one place so they cannot drift.
/// @dev Every member is `internal`/`constant` on purpose: an `external` function on the handler
///      would be swept up by the invariant fuzzer and called as if it were an action.
abstract contract InvariantFixtures {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant FUNDING = 500_000 * UNIT;
    uint256 internal constant SINGLE_TX_LIMIT = 10_000 * UNIT;
    uint256 internal constant DAILY_LIMIT = 20_000 * UNIT;
    uint256 internal constant MONTHLY_LIMIT = 60_000 * UNIT;
    uint256 internal constant AUTO_APPROVE_LIMIT = 5_000 * UNIT;

    /// @dev Deliberately FIXED for the whole run. Several invariants assert that a day's or a
    ///      month's committed total never exceeds its limit, and that statement is only true
    ///      while the limit holds still: the owner is deliberately allowed to lower a limit
    ///      below what is already committed, which strands reservations by design. Policy
    ///      CHANGES — including lowering a limit under a live reservation — are covered
    ///      deterministically in `PolicyLimits.t.sol`, which is where that behaviour is
    ///      actually asserted. Only `allowUnknownRecipients` is varied here, because it touches
    ///      no monetary counter.
    function _policy(bool allowUnknown) internal pure returns (Treasury.Policy memory) {
        return Treasury.Policy({
            singleTxLimit: SINGLE_TX_LIMIT,
            dailyLimit: DAILY_LIMIT,
            monthlyLimit: MONTHLY_LIMIT,
            autoApproveLimit: AUTO_APPROVE_LIMIT,
            allowUnknownRecipients: allowUnknown
        });
    }
}

/// @notice Drives the treasury through random, mostly-illegal action sequences.
/// @dev Every action wraps its call so a revert is recorded rather than propagated. The
///      interesting states are the ones reached by trying something illegal first, so the handler
///      has to survive a revert and keep going.
contract TreasuryHandler is Test, InvariantFixtures {
    Treasury public immutable treasury;
    address public immutable owner;
    address public immutable agent;
    address public immutable recipientA;
    address public immutable recipientB;
    address public immutable unknownRecipient;

    /// @dev The status each payment had at the previous action boundary, so a terminal status
    ///      that later changed would be caught.
    mapping(uint256 => Treasury.PaymentStatus) public lastSeenStatus;

    uint256 private _refs;

    constructor(
        Treasury treasury_,
        address owner_,
        address agent_,
        address recipientA_,
        address recipientB_,
        address unknownRecipient_
    ) {
        treasury = treasury_;
        owner = owner_;
        agent = agent_;
        recipientA = recipientA_;
        recipientB = recipientB_;
        unknownRecipient = unknownRecipient_;
    }

    // -----------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------

    function createPayment(uint256 amountSeed, bool toUnknown) public {
        _observeAll();
        uint256 amount = bound(amountSeed, 1, DAILY_LIMIT);
        address to = toUnknown ? unknownRecipient : (amountSeed % 2 == 0 ? recipientA : recipientB);
        vm.prank(agent);
        try treasury.createPaymentRequest(to, amount, keccak256("inv"), _nextRef()) {} catch {}
    }

    function createPaymentAsOwner(uint256 amountSeed) public {
        _observeAll();
        uint256 amount = bound(amountSeed, 1, DAILY_LIMIT);
        vm.prank(owner);
        try treasury.createPaymentRequest(recipientA, amount, keccak256("inv"), _nextRef()) {} catch {}
    }

    function approve(uint256 idSeed) public {
        _observeAll();
        uint256 id = bound(idSeed, 1, _idCeiling());
        vm.prank(owner);
        try treasury.approvePayment(id) {} catch {}
    }

    function execute(uint256 idSeed) public {
        _observeAll();
        uint256 id = bound(idSeed, 1, _idCeiling());
        // Alternate the caller: only the owner may settle an APPROVED payment, so running both
        // roles is what exercises the authority matrix.
        if (id % 2 == 0) {
            vm.prank(agent);
            try treasury.executePayment(id) {} catch {}
        } else {
            vm.prank(owner);
            try treasury.executePayment(id) {} catch {}
        }
    }

    function reject(uint256 idSeed) public {
        _observeAll();
        uint256 id = bound(idSeed, 1, _idCeiling());
        vm.prank(owner);
        try treasury.rejectPayment(id, keccak256("inv")) {} catch {}
    }

    function allowUnknownRecipients() public {
        vm.prank(owner);
        treasury.setPolicy(_policy(true));
    }

    function disallowUnknownRecipients() public {
        vm.prank(owner);
        treasury.setPolicy(_policy(false));
    }

    function addUnknownRecipient() public {
        vm.prank(owner);
        treasury.addRecipient(unknownRecipient, keccak256("inv"));
    }

    function removeUnknownRecipient() public {
        vm.prank(owner);
        try treasury.removeRecipient(unknownRecipient) {} catch {}
    }

    function pause() public {
        _observeAll();
        vm.prank(owner);
        try treasury.pause() {} catch {}
    }

    function unpause() public {
        vm.prank(owner);
        try treasury.unpause() {} catch {}
    }

    function warpForwardHours(uint256 hoursSeed) public {
        vm.warp(block.timestamp + bound(hoursSeed, 1, 72) * 1 hours);
    }

    function warpForwardDays(uint256 daysSeed) public {
        vm.warp(block.timestamp + bound(daysSeed, 1, 45) * 1 days);
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    function _idCeiling() internal view returns (uint256) {
        uint256 n = treasury.paymentCount();
        return n == 0 ? 1 : n;
    }

    function _nextRef() internal returns (bytes32) {
        unchecked {
            _refs += 1;
        }
        return keccak256(abi.encode("invariant-ref", _refs));
    }

    /// @dev The auto-generated `payments` getter returns a flat tuple, so `status` is field 5.
    function _statusOf(uint256 id) internal view returns (Treasury.PaymentStatus) {
        (,,,, Treasury.PaymentStatus s,,,,,) = treasury.payments(id);
        return s;
    }

    function _observeAll() internal {
        uint256 n = treasury.paymentCount();
        for (uint256 i = 1; i <= n; i++) {
            lastSeenStatus[i] = _statusOf(i);
        }
    }
}

/// @notice Accounting invariants: the money and the counters must always agree, whatever order
///         legal and illegal actions arrive in.
contract AccountingInvariantTest is Test, InvariantFixtures {
    Treasury internal treasury;
    TreasuryHandler internal handler;

    address internal owner;
    address internal agent;

    function setUp() public {
        owner = makeAddr("owner");
        agent = makeAddr("agent");

        // This test contract is the mock's faucet authority, so it funds the treasury directly.
        MockERC20 asset = new MockERC20(address(this));
        treasury = new Treasury(IERC20(address(asset)), owner, agent);
        asset.mint(address(treasury), FUNDING);

        handler = new TreasuryHandler(
            treasury,
            owner,
            agent,
            makeAddr("invRecipientA"),
            makeAddr("invRecipientB"),
            makeAddr("invUnknownRecipient")
        );

        vm.startPrank(owner);
        treasury.addRecipient(handler.recipientA(), keccak256("a"));
        treasury.addRecipient(handler.recipientB(), keccak256("b"));
        treasury.setPolicy(_policy(false));
        vm.stopPrank();

        targetContract(address(handler));
    }

    // -----------------------------------------------------------------
    // Invariant 1: lifetime counters equal the sum implied by payment statuses
    // -----------------------------------------------------------------

    function invariant_LifetimeReservedEqualsSumOfReservingPayments() public view {
        uint256 expected;
        uint256 n = treasury.paymentCount();
        for (uint256 i = 1; i <= n; i++) {
            Treasury.PaymentRequest memory p = treasury.getPayment(i);
            if (_isReserving(p.status)) expected += p.amount;
        }
        assertEq(treasury.lifetimeReserved(), expected, "lifetimeReserved == sum held by reserving payments");
    }

    function invariant_LifetimeSpentEqualsSumOfExecutedPayments() public view {
        uint256 expected = _sumExecuted();
        assertEq(treasury.lifetimeSpent(), expected, "lifetimeSpent == sum of executed payments");
    }

    // -----------------------------------------------------------------
    // Invariant 2: token conservation
    // -----------------------------------------------------------------

    function invariant_TokenInPlusTokenOutEqualsFunding() public view {
        uint256 treasuryBalance = treasury.asset().balanceOf(address(treasury));
        assertEq(treasuryBalance + _sumExecuted(), FUNDING, "tokens conserved: nothing minted, nothing lost");
    }

    function invariant_TreasuryNeverSettlesMoreThanItEverHeld() public view {
        assertLe(treasury.lifetimeSpent(), FUNDING, "cannot settle more than was ever held");
    }

    // -----------------------------------------------------------------
    // Invariant 3: per-bucket reservations match the per-bucket reserving payments
    // -----------------------------------------------------------------

    /// @dev The strongest accounting statement available: for EVERY bucket that holds a
    ///      reservation, the counter equals exactly the sum of the amounts of the payments that
    ///      still reserve in that bucket. A release that debited the wrong bucket, or missed one
    ///      entirely, moves these numbers and fails the test.
    function invariant_EveryDayBucketEqualsTheReservingPaymentsInIt() public view {
        (uint256 count, uint256[] memory buckets, uint256[] memory amounts) = _groupReservingBy(false);
        for (uint256 i = 0; i < count; i++) {
            assertEq(
                treasury.reservedDay(buckets[i]), amounts[i], "day bucket matches the reserving payments in it"
            );
        }
    }

    function invariant_EveryMonthBucketEqualsTheReservingPaymentsInIt() public view {
        (uint256 count, uint256[] memory buckets, uint256[] memory amounts) = _groupReservingBy(true);
        for (uint256 i = 0; i < count; i++) {
            assertEq(
                treasury.reservedMonth(buckets[i]), amounts[i], "month bucket matches the reserving payments in it"
            );
        }
    }

    // -----------------------------------------------------------------
    // Invariant 4: no day or month ever carries more than its limit
    // -----------------------------------------------------------------

    function invariant_CurrentDayCommittedNeverExceedsDailyLimit() public view {
        uint256 day = treasury.currentDayIndex();
        uint256 committed = treasury.reservedDay(day) + treasury.spentDay(day);
        assertLe(committed, DAILY_LIMIT, "day committed within limit");
    }

    function invariant_CurrentMonthCommittedNeverExceedsMonthlyLimit() public view {
        uint256 month = treasury.currentMonthKey();
        uint256 committed = treasury.reservedMonth(month) + treasury.spentMonth(month);
        assertLe(committed, MONTHLY_LIMIT, "month committed within limit");
    }

    function invariant_HeadroomNeverExceedsTheConfiguredLimits() public view {
        (, uint256 dayRemaining, uint256 monthRemaining) = treasury.previewHeadroom();
        assertLe(dayRemaining, DAILY_LIMIT, "day headroom within limit");
        assertLe(monthRemaining, MONTHLY_LIMIT, "month headroom within limit");
    }

    // -----------------------------------------------------------------
    // Invariant 5: the lifecycle is monotonic
    // -----------------------------------------------------------------

    function invariant_StatusOnlyEverMovesAlongALegalTransition() public view {
        uint256 n = treasury.paymentCount();
        for (uint256 i = 1; i <= n; i++) {
            Treasury.PaymentStatus was = handler.lastSeenStatus(i);
            if (was == Treasury.PaymentStatus.None) continue; // not observed at a boundary yet
            Treasury.PaymentStatus now_ = _statusOf(i);
            if (now_ == was) continue; // staying put is always legal
            assertTrue(_isLegalTransition(was, now_), "illegal status transition");
        }
    }

    function invariant_TerminalStatusesAreNeverLeft() public view {
        uint256 n = treasury.paymentCount();
        for (uint256 i = 1; i <= n; i++) {
            Treasury.PaymentStatus was = handler.lastSeenStatus(i);
            if (was != Treasury.PaymentStatus.Executed && was != Treasury.PaymentStatus.Rejected) continue;
            assertEq(uint8(_statusOf(i)), uint8(was), "executed and rejected are terminal");
        }
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _isReserving(Treasury.PaymentStatus s) internal pure returns (bool) {
        return s == Treasury.PaymentStatus.AutoApproved || s == Treasury.PaymentStatus.Approved;
    }

    /// @dev The complete legal transition set. Anything outside it is a bug: in particular there
    ///      is no path out of `Executed` or `Rejected`, and no way to un-`Blocked` a payment.
    function _isLegalTransition(Treasury.PaymentStatus from, Treasury.PaymentStatus to)
        internal
        pure
        returns (bool)
    {
        if (from == Treasury.PaymentStatus.Pending) {
            return to == Treasury.PaymentStatus.Approved || to == Treasury.PaymentStatus.Rejected
                || to == Treasury.PaymentStatus.Blocked;
        }
        if (from == Treasury.PaymentStatus.AutoApproved) {
            return to == Treasury.PaymentStatus.Executed || to == Treasury.PaymentStatus.Rejected;
        }
        if (from == Treasury.PaymentStatus.Approved) {
            return to == Treasury.PaymentStatus.Executed || to == Treasury.PaymentStatus.Rejected;
        }
        if (from == Treasury.PaymentStatus.Blocked) {
            return to == Treasury.PaymentStatus.Rejected;
        }
        return false; // Executed and Rejected are terminal
    }

    function _statusOf(uint256 id) internal view returns (Treasury.PaymentStatus) {
        (,,,, Treasury.PaymentStatus s,,,,,) = treasury.payments(id);
        return s;
    }

    function _sumExecuted() internal view returns (uint256 sum) {
        uint256 n = treasury.paymentCount();
        for (uint256 i = 1; i <= n; i++) {
            Treasury.PaymentRequest memory p = treasury.getPayment(i);
            if (p.status == Treasury.PaymentStatus.Executed) sum += p.amount;
        }
    }

    /// @dev Groups the amount of every currently-reserving payment by the bucket it reserved in.
    ///      Solidity has no memory mappings and memory arrays cannot grow, so the arrays are
    ///      pre-sized to the payment count — an upper bound on the number of distinct buckets —
    ///      with a separate `count` of live slots. The bucket count is tiny (one entry per
    ///      calendar day/month a run touches), so the linear scan is cheap.
    function _groupReservingBy(bool byMonth)
        internal
        view
        returns (uint256 count, uint256[] memory buckets, uint256[] memory amounts)
    {
        uint256 n = treasury.paymentCount();
        buckets = new uint256[](n);
        amounts = new uint256[](n);

        for (uint256 i = 1; i <= n; i++) {
            Treasury.PaymentRequest memory p = treasury.getPayment(i);
            if (!_isReserving(p.status)) continue;
            uint256 bucket = byMonth ? p.monthKey : p.dayIndex;

            uint256 slot = count;
            for (uint256 j = 0; j < count; j++) {
                if (buckets[j] == bucket) {
                    slot = j;
                    break;
                }
            }
            if (slot == count) count++;

            buckets[slot] = bucket;
            amounts[slot] += p.amount;
        }
    }
}
