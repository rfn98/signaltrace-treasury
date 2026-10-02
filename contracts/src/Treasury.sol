// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Calendar} from "./libraries/Calendar.sol";

/// @title SignalTrace Treasury
/// @notice Policy-enforced treasury for AI-native teams. The contract is the ONLY financial
///         authority: it never reads the database, never reads AI output, and re-derives every
///         financial constraint from its own storage at execution time.
///
/// @dev Core security properties (see docs/THREAT-MODEL.md):
///
///      1. AUTHORITY IS A FUNCTION OF (role, payment.status), NOT OF role alone.
///         `AGENT_ROLE` may execute ONLY an `AUTO_APPROVED` payment. An `APPROVED` payment
///         requires `OWNER_ROLE`. There is no third role and no bypass entry point.
///      2. RESERVED vs SETTLED ACCOUNTING. Two independent bounds are enforced:
///           - `reservedDay/Month` stop N concurrent approvals from collectively over-committing.
///           - `spentDay/Month` stop reservations parked across a UTC boundary from letting two
///             days of spending happen on one day.
///         One counter is not enough; v1 of this design had exactly this bypass.
///      3. RESERVATIONS ARE BOUND TO THE BUCKET THEY WERE MADE IN. A payment stores its
///         `dayIndex`/`monthKey` at reserve time, and every subsequent check and release uses
///         those keys rather than `block.timestamp`.
///      4. `0 = unlimited` FOR LIMITS, `0 = disabled` FOR AUTO-APPROVAL. Zero-guarded on every
///         comparison so a zero limit is never read as the tightest possible limit.
///      5. The asset is `immutable` and this contract holds no ETH. There is no token-swap
///         drain vector and no allowance surface: the treasury never calls `approve()`.
contract Treasury is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @dev Configures policy, manages recipients, approves/rejects, executes, pauses.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    /// @dev Creates payment requests. May execute `AUTO_APPROVED` payments. Nothing else.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Treasury-wide financial policy. A zero limit means UNLIMITED.
    /// @param singleTxLimit        Max amount for one payment. 0 = unlimited.
    /// @param dailyLimit           Max committed + settled per UTC calendar day. 0 = unlimited.
    /// @param monthlyLimit         Max committed + settled per UTC calendar month. 0 = unlimited.
    /// @param autoApproveLimit     Max amount that may auto-approve. 0 = auto-approval DISABLED.
    /// @param allowUnknownRecipients Whether a recipient absent from the allowlist may be paid.
    struct Policy {
        uint256 singleTxLimit;
        uint256 dailyLimit;
        uint256 monthlyLimit;
        uint256 autoApproveLimit;
        bool allowUnknownRecipients;
    }

    struct Recipient {
        bool approved;
        bytes32 category;
        uint64 addedAt;
    }

    enum PaymentStatus {
        None,
        Pending,
        AutoApproved,
        Approved,
        Rejected,
        Executed,
        Blocked
    }

    struct PaymentRequest {
        address recipient;
        uint256 amount;
        bytes32 category;
        /// @dev Named `paymentRef` rather than `reference` because `reference` is a reserved
        ///      keyword as of Solidity 0.8.28. Off-chain this is called the payment `reference`.
        bytes32 paymentRef;
        PaymentStatus status;
        uint128 createdAt;
        uint128 updatedAt;
        /// @dev UTC day bucket this payment was RESERVED in. Written at reserve time, not at
        ///      execution time, so a policy lowering or a month rollover cannot launder it.
        uint256 dayIndex;
        /// @dev UTC month bucket this payment was RESERVED in.
        uint256 monthKey;
        address approvedBy;
    }

    /// @notice Machine-readable rejection reason. Values are stable: the application decodes
    ///         them to render a specific explanation instead of a generic failure.
    enum ReasonCode {
        None, // 0
        InvalidRecipient, // 1
        ZeroAmount, // 2
        SelfTransfer, // 3
        UnknownRecipient, // 4
        SingleTxLimit, // 5
        DailyLimit, // 6
        MonthlyLimit, // 7
        InsufficientBalance, // 8
        Paused, // 9
        CallerNotAuthorized, // 10
        PaymentNotReserved, // 11
        NotExecutable // 12
    }

    /// @dev Result of a policy evaluation, carrying the numbers needed to explain the failure.
    struct CheckResult {
        uint16 reason;
        uint256 limit;
        uint256 actual;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The treasury asset. Immutable by design: a mutable asset would be a drain vector.
    IERC20 public immutable asset;

    /// @notice `asset.decimals()` snapshotted at construction so amounts render without an
    ///         off-chain constant. Safe to read from the constructor because `asset` is a
    ///         `calldata` address (no reentrancy / no state read of `this`).
    uint8 public immutable assetDecimals;

    Policy public policy;

    mapping(address => Recipient) public recipients;

    uint256 public paymentCount;
    mapping(uint256 => PaymentRequest) public payments;

    /// @notice Deterministic off-chain reference -> on-chain id. Makes the join auditable in
    ///         both directions and makes reference reuse revert (request-layer replay guard).
    mapping(bytes32 => uint256) public referenceToId;

    // --- In-flight reservations, bucketed at RESERVE time -------------------------
    mapping(uint256 => uint256) public reservedDay; // dayIndex => atomic units
    mapping(uint256 => uint256) public reservedMonth; // monthKey => atomic units
    uint256 public lifetimeReserved;

    // --- Settled outflow, bucketed at EXECUTE time --------------------------------
    mapping(uint256 => uint256) public spentDay; // dayIndex => atomic units
    mapping(uint256 => uint256) public spentMonth; // monthKey => atomic units
    uint256 public lifetimeSpent;

    uint256 private _adminCount;

    // ---------------------------------------------------------------------
    // Events (flat primitives only: no structs, arrays, or strings)
    // ---------------------------------------------------------------------

    event PaymentRequested(
        uint256 indexed id,
        bytes32 indexed paymentRef,
        address indexed recipient,
        uint256 amount,
        bytes32 category,
        uint8 status
    );
    event PaymentApproved(
        uint256 indexed id, address indexed actor, uint256 amount, uint256 dayIndex, uint256 monthKey
    );
    event PaymentRejected(
        uint256 indexed id,
        address indexed actor,
        bytes32 reason,
        uint256 releasedAmount,
        uint256 dayIndex,
        uint256 monthKey
    );
    event PaymentExecuted(
        uint256 indexed id,
        address indexed recipient,
        uint256 amount,
        uint256 dayIndex,
        uint256 monthKey,
        uint256 spentDayTotal,
        uint256 spentMonthTotal
    );
    event PaymentBlocked(uint256 indexed id, address indexed recipient, uint256 amount, uint16 reasonCode);
    event PolicyUpdated(
        uint256 prevSingleTxLimit,
        uint256 prevDailyLimit,
        uint256 prevMonthlyLimit,
        uint256 prevAutoApproveLimit,
        bool prevAllowUnknownRecipients,
        uint256 newSingleTxLimit,
        uint256 newDailyLimit,
        uint256 newMonthlyLimit,
        uint256 newAutoApproveLimit,
        bool newAllowUnknownRecipients
    );
    event RecipientAdded(address indexed recipient, bytes32 category);
    event RecipientRemoved(address indexed recipient, address indexed actor);
    event RecipientApprovalChanged(address indexed recipient, bool approved, bytes32 category);
    event Funded(address indexed from, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAuthorized(address account, bytes32 role);
    error InvalidRecipient();
    error ZeroAmount();
    error InvalidReference();
    error ReferenceAlreadyUsed(bytes32 paymentRef);
    error PaymentNotFound(uint256 id);
    error PaymentNotExecutable(uint256 id, PaymentStatus current);
    error PaymentNotApprovable(uint256 id, PaymentStatus current);
    error PaymentNotRejectable(uint256 id, PaymentStatus current);
    error PaymentNotReserved(uint256 id);
    /// @param reasonCode `ReasonCode` enum value.
    /// @param limit The limit in force, or 0 when the reason is not limit-based.
    /// @param actual The offending value.
    error PolicyViolation(uint16 reasonCode, uint256 limit, uint256 actual);
    error InvalidPolicyConfiguration();
    error InsufficientBalance(uint256 required, uint256 available);
    error LastAdmin();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyAnyRole(bytes32 roleA, bytes32 roleB) {
        if (!hasRole(roleA, msg.sender) && !hasRole(roleB, msg.sender)) {
            revert NotAuthorized(msg.sender, roleA);
        }
        _;
    }

    /// @dev Overrides OpenZeppelin's default `AccessControlUnauthorizedAccount` so that EVERY
    ///      access-control failure on this contract surfaces the same typed `NotAuthorized`
    ///      error, carrying the role that was missing. A single error shape means the application
    ///      and the test-suite never have to special-case which internal guard fired, and it keeps
    ///      the emitted error surface of this contract under our own control rather than a
    ///      dependency's.
    function _checkRole(bytes32 role, address account) internal view override {
        if (!hasRole(role, account)) revert NotAuthorized(account, role);
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param asset_ The ERC20 this treasury settles in. Immutable for the contract's lifetime.
    /// @param admin  Receives `DEFAULT_ADMIN_ROLE` and `OWNER_ROLE`.
    /// @param agent  Receives `AGENT_ROLE`. May create requests and execute AUTO_APPROVED only.
    constructor(IERC20 asset_, address admin, address agent) {
        if (address(asset_) == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (agent == address(0)) revert ZeroAddress();

        asset = asset_;
        assetDecimals = IERC20Decimals(address(asset_)).decimals();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OWNER_ROLE, admin);
        _grantRole(AGENT_ROLE, agent);
        _adminCount = 1;
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    /// @notice Pull `amount` of the asset into the treasury, emitting an auditable `Funded`.
    /// @dev The treasury never calls `approve()`, so it exposes no allowance surface.
    function fund(uint256 amount) external onlyRole(OWNER_ROLE) {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Policy & recipients
    // ---------------------------------------------------------------------

    /// @notice Replace the treasury policy.
    /// @dev Zero-guarded ordering checks. `0 = unlimited` on the three limits, so a zero is
    ///      never compared as though it were the tightest possible value:
    ///        - `singleTxLimit = 0` (unlimited) with `autoApproveLimit = 5_000` is VALID.
    ///        - `dailyLimit = 0` (unlimited) with `autoApproveLimit = 5_000` is VALID.
    ///      `autoApproveLimit = 0` is the one exception to the convention: it means
    ///      auto-approval is DISABLED, not unlimited. Treating it as unlimited would hand the
    ///      agent unbounded autonomous spend, which is the exact failure this contract exists
    ///      to prevent.
    function setPolicy(Policy calldata p) external onlyRole(OWNER_ROLE) {
        if (p.singleTxLimit != 0 && p.autoApproveLimit > p.singleTxLimit) {
            revert InvalidPolicyConfiguration();
        }
        if (p.dailyLimit != 0 && p.autoApproveLimit > p.dailyLimit) {
            revert InvalidPolicyConfiguration();
        }
        if (p.monthlyLimit != 0 && p.dailyLimit > p.monthlyLimit) {
            revert InvalidPolicyConfiguration();
        }

        Policy memory prev = policy;
        policy = p;

        emit PolicyUpdated(
            prev.singleTxLimit,
            prev.dailyLimit,
            prev.monthlyLimit,
            prev.autoApproveLimit,
            prev.allowUnknownRecipients,
            p.singleTxLimit,
            p.dailyLimit,
            p.monthlyLimit,
            p.autoApproveLimit,
            p.allowUnknownRecipients
        );
    }

    /// @notice Add a recipient to the allowlist, or re-register an existing one.
    function addRecipient(address who, bytes32 category) external onlyRole(OWNER_ROLE) {
        if (who == address(0)) revert ZeroAddress();
        if (who == address(this)) revert InvalidRecipient();
        recipients[who] = Recipient({approved: true, category: category, addedAt: block.timestamp.toUint64()});
        emit RecipientAdded(who, category);
    }

    /// @notice Set a recipient's allowlist status without removing its history.
    function setRecipientApproved(address who, bool approved, bytes32 category) external onlyRole(OWNER_ROLE) {
        if (who == address(0)) revert ZeroAddress();
        Recipient storage r = recipients[who];
        r.approved = approved;
        r.category = category;
        if (approved && r.addedAt == 0) r.addedAt = block.timestamp.toUint64();
        emit RecipientApprovalChanged(who, approved, category);
    }

    /// @notice Remove a recipient from the allowlist. History is preserved on-chain in events.
    function removeRecipient(address who) external onlyRole(OWNER_ROLE) {
        if (!recipients[who].approved) revert InvalidRecipient();
        delete recipients[who];
        emit RecipientRemoved(who, msg.sender);
    }

    function pause() external onlyRole(OWNER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OWNER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Payment lifecycle
    // ---------------------------------------------------------------------

    /// @notice Create a payment request. Callable by `AGENT_ROLE` or `OWNER_ROLE`.
    /// @dev The contract evaluates policy ITSELF and assigns the status. A request that violates
    ///      policy is recorded as `Blocked` rather than reverted, so the attempt gets an id and
    ///      a permanent `PaymentBlocked` event: an attack attempt must be auditable, not invisible.
    ///      `Blocked` is terminal. To retry after fixing the policy or allowlist, create a new
    ///      request.
    /// @param paymentRef Deterministic caller-supplied id, unique within this treasury.
    function createPaymentRequest(address to, uint256 amount, bytes32 category, bytes32 paymentRef)
        external
        onlyAnyRole(AGENT_ROLE, OWNER_ROLE)
        returns (uint256 id)
    {
        if (paymentRef == bytes32(0)) revert InvalidReference();
        if (referenceToId[paymentRef] != 0) revert ReferenceAlreadyUsed(paymentRef);

        uint256 dayKey = Calendar.currentDayIndex();
        uint256 monthKey = Calendar.currentMonthKey();

        // Ids start at 1 so that `referenceToId[ref] == 0` unambiguously means "unused".
        id = ++paymentCount;

        PaymentRequest storage p = payments[id];
        p.recipient = to;
        p.amount = amount;
        p.category = category;
        p.paymentRef = paymentRef;
        p.status = PaymentStatus.Pending;
        p.createdAt = block.timestamp.toUint128();
        p.updatedAt = block.timestamp.toUint128();
        p.dayIndex = dayKey;
        p.monthKey = monthKey;
        referenceToId[paymentRef] = id;

        CheckResult memory r = _creationCheck(to, amount, dayKey, monthKey);

        if (r.reason != uint16(ReasonCode.None)) {
            p.status = PaymentStatus.Blocked;
            emit PaymentBlocked(id, to, amount, r.reason);
        } else if (policy.autoApproveLimit != 0 && amount <= policy.autoApproveLimit) {
            // autoApproveLimit == 0 means DISABLED (see setPolicy docs).
            p.status = PaymentStatus.AutoApproved;
            _reserve(amount, dayKey, monthKey);
        }

        emit PaymentRequested(id, paymentRef, to, amount, category, uint8(p.status));
    }

    /// @notice Approve a `Pending` payment, reserving its budget. `OWNER_ROLE` only.
    /// @dev Re-evaluates policy at approval time, so a policy change between request and
    ///      approval is caught. The reservation is booked into the bucket current at APPROVAL
    ///      time, not the bucket current at request time.
    function approvePayment(uint256 id) external onlyRole(OWNER_ROLE) {
        PaymentRequest storage p = _requirePayment(id);
        if (p.status != PaymentStatus.Pending) revert PaymentNotApprovable(id, p.status);

        uint256 dayKey = Calendar.currentDayIndex();
        uint256 monthKey = Calendar.currentMonthKey();

        CheckResult memory r = _creationCheck(p.recipient, p.amount, dayKey, monthKey);
        if (r.reason != uint16(ReasonCode.None)) {
            revert PolicyViolation(r.reason, r.limit, r.actual);
        }

        _reserve(p.amount, dayKey, monthKey);
        p.dayIndex = dayKey;
        p.monthKey = monthKey;
        p.status = PaymentStatus.Approved;
        p.approvedBy = msg.sender;
        p.updatedAt = block.timestamp.toUint128();

        emit PaymentApproved(id, msg.sender, p.amount, dayKey, monthKey);
    }

    /// @notice Reject a payment. `OWNER_ROLE` only.
    /// @dev Accepts `Pending`, `AutoApproved`, `Approved` and `Blocked`. Rejecting a payment
    ///      that holds a reservation RELEASES it, from the bucket recorded on the payment
    ///      (`p.dayIndex` / `p.monthKey`) and never from `block.timestamp` — otherwise a
    ///      rejection issued on a later day would corrupt the wrong day and leak budget.
    ///
    ///      This is also the only escape from a policy-lowered freeze: see `executePayment`.
    function rejectPayment(uint256 id, bytes32 reason) external onlyRole(OWNER_ROLE) {
        PaymentRequest storage p = _requirePayment(id);
        PaymentStatus s = p.status;
        if (s == PaymentStatus.Rejected || s == PaymentStatus.Executed) {
            revert PaymentNotRejectable(id, s);
        }

        if (s == PaymentStatus.AutoApproved || s == PaymentStatus.Approved) {
            _release(p.amount, p.dayIndex, p.monthKey);
            p.status = PaymentStatus.Rejected;
            p.updatedAt = block.timestamp.toUint128();
            emit PaymentRejected(id, msg.sender, reason, p.amount, p.dayIndex, p.monthKey);
        } else {
            // Pending or Blocked: nothing was reserved, so there is nothing to release.
            p.status = PaymentStatus.Rejected;
            p.updatedAt = block.timestamp.toUint128();
            emit PaymentRejected(id, msg.sender, reason, 0, 0, 0);
        }
    }

    /// @notice Settle a payment. Callable by `AGENT_ROLE` or `OWNER_ROLE`, but authority depends
    ///         on the payment's status:
    ///
    ///         AUTO_APPROVED -> owner or agent may execute
    ///         APPROVED      -> OWNER_ROLE only. An agent always reverts.
    ///         PENDING | BLOCKED | REJECTED | EXECUTED -> nobody, always.
    ///
    /// @dev This is the security boundary. Every financial constraint is re-derived here from
    ///      this contract's own storage. A backend that lies about approval, a database row
    ///      forged to `EXECUTED`, or an AI output claiming `AUTO_EXECUTE` are all irrelevant:
    ///      none of them are inputs to this function.
    ///
    ///      If the owner LOWERS a limit below an amount that is already reserved, execution of
    ///      that payment REVERTS. This is intentional fail-safe behaviour. There is deliberately
    ///      no privileged override; the only cures are raising the limit back or calling
    ///      `rejectPayment` to release the reservation.
    function executePayment(uint256 id) external nonReentrant whenNotPaused {
        PaymentRequest storage p = _requirePayment(id);

        // Coarse gate first so a stranger learns nothing about a payment's state.
        if (!hasRole(AGENT_ROLE, msg.sender) && !hasRole(OWNER_ROLE, msg.sender)) {
            revert NotAuthorized(msg.sender, AGENT_ROLE);
        }

        CheckResult memory r = _executionCheck(id, msg.sender);
        if (r.reason != uint16(ReasonCode.None)) {
            _revertWithReason(id, p, r);
        }

        uint256 amount = p.amount;
        uint256 settleDayKey = Calendar.currentDayIndex();
        uint256 settleMonthKey = Calendar.currentMonthKey();

        // --- effects ---
        _release(amount, p.dayIndex, p.monthKey);
        spentDay[settleDayKey] += amount;
        spentMonth[settleMonthKey] += amount;
        lifetimeSpent += amount;

        p.status = PaymentStatus.Executed;
        p.updatedAt = block.timestamp.toUint128();

        // --- interaction (ReentrancyGuard + checks-effects-interactions) ---
        asset.safeTransfer(p.recipient, amount);

        emit PaymentExecuted(
            id, p.recipient, amount, settleDayKey, settleMonthKey, spentDay[settleDayKey], spentMonth[settleMonthKey]
        );
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Would `caller` be able to execute payment `id` right now?
    /// @dev Mirrors `executePayment` exactly: same shared `_executionCheck`, so the UI's verdict
    ///      and the actual transaction outcome cannot disagree.
    function canExecute(uint256 id, address caller) external view returns (bool allowed, uint16 reason) {
        if (id == 0 || id > paymentCount) revert PaymentNotFound(id);
        uint16 r = paused() ? uint16(ReasonCode.Paused) : _executionCheck(id, caller).reason;
        return (r == uint16(ReasonCode.None), r);
    }

    /// @notice Would `createPaymentRequest(to, amount, ...)` be blocked right now?
    /// @dev Status-independent policy preview for the "Policy Check" panel.
    function evaluatePayment(address to, uint256 amount) external view returns (bool allowed, uint16 reason) {
        CheckResult memory r = _creationCheck(to, amount, Calendar.currentDayIndex(), Calendar.currentMonthKey());
        return (r.reason == uint16(ReasonCode.None), r.reason);
    }

    function getPayment(uint256 id) external view returns (PaymentRequest memory) {
        return _requirePayment(id);
    }

    function currentDayIndex() external view returns (uint256) {
        return Calendar.currentDayIndex();
    }

    function currentMonthKey() external view returns (uint256) {
        return Calendar.currentMonthKey();
    }

    function currentYearMonth() external view returns (uint16 year, uint8 month) {
        return Calendar.currentYearMonth();
    }

    /// @notice Committed (reserved + already settled) figures for the current UTC day and month.
    /// @dev Sums both counters to match the `dailyLimit` / `monthlyLimit` semantics enforced by
    ///      `_periodCheck` and consumed by `previewHeadroom`. Reporting `reserved` alone would
    ///      under-state the day's real obligations and hand the UI more headroom than exists.
    function currentUsage() external view returns (uint256 dayCommitted, uint256 monthCommitted) {
        uint256 dayKey = Calendar.currentDayIndex();
        uint256 monthKey = Calendar.currentMonthKey();
        return (reservedDay[dayKey] + spentDay[dayKey], reservedMonth[monthKey] + spentMonth[monthKey]);
    }

    /// @notice Remaining headroom against the configured limits. A `0` limit reports `type(uint256).max`.
    function previewHeadroom()
        external
        view
        returns (
            uint256 singleTxRemaining,
            uint256 dayRemaining,
            uint256 monthRemaining
        )
    {
        uint256 dayUsed = reservedDay[Calendar.currentDayIndex()] + spentDay[Calendar.currentDayIndex()];
        uint256 monthUsed = reservedMonth[Calendar.currentMonthKey()] + spentMonth[Calendar.currentMonthKey()];
        singleTxRemaining = policy.singleTxLimit == 0 ? type(uint256).max : policy.singleTxLimit;
        dayRemaining =
            policy.dailyLimit == 0 ? type(uint256).max : (policy.dailyLimit > dayUsed ? policy.dailyLimit - dayUsed : 0);
        monthRemaining = policy.monthlyLimit == 0
            ? type(uint256).max
            : (policy.monthlyLimit > monthUsed ? policy.monthlyLimit - monthUsed : 0);
    }

    /// @notice True when the owner has configured agent auto-execution with no effective bound.
    /// @dev The contract cannot prevent this — the owner chose it — but the product must not
    ///      stay silent about it. Surfaced as a red warning in the policy editor.
    function hasUnboundedAutoApproval() external view returns (bool) {
        return policy.autoApproveLimit != 0 && policy.singleTxLimit == 0 && policy.dailyLimit == 0;
    }

    // ---------------------------------------------------------------------
    // Internal: policy evaluation
    // ---------------------------------------------------------------------

    function _requirePayment(uint256 id) private view returns (PaymentRequest storage) {
        if (id == 0 || id > paymentCount) revert PaymentNotFound(id);
        return payments[id];
    }

    /// @dev Per-payment facts: address validity, allowlist, single-tx limit, available balance.
    ///      Does NOT consider the payment's status or the caller's roles.
    function _corePolicyCheck(address to, uint256 amount) private view returns (CheckResult memory) {
        if (to == address(0)) return CheckResult(uint16(ReasonCode.InvalidRecipient), 0, 0);
        if (amount == 0) return CheckResult(uint16(ReasonCode.ZeroAmount), 0, 0);
        if (to == address(this)) return CheckResult(uint16(ReasonCode.SelfTransfer), 0, amount);
        if (!recipients[to].approved && !policy.allowUnknownRecipients) {
            return CheckResult(uint16(ReasonCode.UnknownRecipient), 0, amount);
        }
        // Zero-guarded: 0 means UNLIMITED, so a zero must never be read as the tightest limit.
        if (policy.singleTxLimit != 0 && amount > policy.singleTxLimit) {
            return CheckResult(uint16(ReasonCode.SingleTxLimit), policy.singleTxLimit, amount);
        }
        uint256 available = asset.balanceOf(address(this));
        if (available < amount) {
            return CheckResult(uint16(ReasonCode.InsufficientBalance), available, amount);
        }
        return CheckResult(uint16(ReasonCode.None), 0, 0);
    }

    /// @dev A single UTC day's committed total, as the `dailyLimit` defines it.
    ///
    ///      The two counters are kept separately for a reason — `reserved` answers "how much is
    ///      promised", `spent` answers "how much has moved" — but the LIMIT applies to their SUM.
    ///      That is the semantics the `Policy` docs and `previewHeadroom` both promise, and it is
    ///      the only reading that is actually safe. Validating them as two independent bounds
    ///      lets `reserved == L` and `spent == L` hold at once, so a single day can carry 2L of
    ///      obligations. Reaching that state needs no attacker: approve a payment on day 1, let
    ///      the day roll over, fill day 2 with a fresh reservation, then settle the day-1 payment
    ///      on day 2. The reservation leaves its day-1 bucket while the spend lands in day 2, so
    ///      two days of budget stack onto day 2 and the daily cap is spent twice.
    ///
    /// @param dayKey Bucket to evaluate.
    /// @param delta  Amount that will be added to this bucket beyond the counters as they stand
    ///               (0 for a pure "is this bucket still legal" check).
    function _dayCheck(uint256 dayKey, uint256 delta) private view returns (CheckResult memory) {
        if (policy.dailyLimit == 0) return CheckResult(uint16(ReasonCode.None), 0, 0);
        uint256 total = reservedDay[dayKey] + spentDay[dayKey] + delta;
        if (total > policy.dailyLimit) {
            return CheckResult(uint16(ReasonCode.DailyLimit), policy.dailyLimit, total);
        }
        return CheckResult(uint16(ReasonCode.None), 0, 0);
    }

    /// @dev The civil-month equivalent of `_dayCheck`. See that function for why the counters
    ///      are summed rather than bounded independently.
    function _monthCheck(uint256 monthKey, uint256 delta) private view returns (CheckResult memory) {
        if (policy.monthlyLimit == 0) return CheckResult(uint16(ReasonCode.None), 0, 0);
        uint256 total = reservedMonth[monthKey] + spentMonth[monthKey] + delta;
        if (total > policy.monthlyLimit) {
            return CheckResult(uint16(ReasonCode.MonthlyLimit), policy.monthlyLimit, total);
        }
        return CheckResult(uint16(ReasonCode.None), 0, 0);
    }

    /// @dev Full evaluation a request must pass to be created as `Pending` or `AutoApproved`.
    function _creationCheck(address to, uint256 amount, uint256 dayKey, uint256 monthKey)
        private
        view
        returns (CheckResult memory)
    {
        CheckResult memory c = _corePolicyCheck(to, amount);
        if (c.reason != uint16(ReasonCode.None)) return c;
        c = _dayCheck(dayKey, amount);
        if (c.reason != uint16(ReasonCode.None)) return c;
        return _monthCheck(monthKey, amount);
    }

    /// @dev The single source of truth for whether `caller` may execute `id`, and why not.
    ///      Shared by `executePayment` and `canExecute` so the two can never drift.
    function _executionCheck(uint256 id, address caller) private view returns (CheckResult memory) {
        PaymentRequest storage p = payments[id];
        PaymentStatus s = p.status;

        // ---- authority is a function of (role, status) ----
        if (s == PaymentStatus.Approved) {
            if (!hasRole(OWNER_ROLE, caller)) {
                return CheckResult(uint16(ReasonCode.CallerNotAuthorized), 0, 0);
            }
        } else if (s != PaymentStatus.AutoApproved) {
            return CheckResult(uint16(ReasonCode.NotExecutable), 0, 0);
        }
        // status == AutoApproved: OWNER_ROLE and AGENT_ROLE are both permitted.

        // A zero dayIndex would mean a zero-initialised reservation, whose bucket
        // (reservedDay[0] == 0) would trivially pass the daily check. Refuse it.
        if (p.dayIndex == 0) return CheckResult(uint16(ReasonCode.PaymentNotReserved), 0, 0);

        CheckResult memory c = _corePolicyCheck(p.recipient, p.amount);
        if (c.reason != uint16(ReasonCode.None)) return c;

        // The reservation's own buckets must still satisfy the CURRENT policy. This is what
        // makes a policy lowering strand existing reservations, by design.
        c = _dayCheck(p.dayIndex, 0);
        if (c.reason != uint16(ReasonCode.None)) return c;
        c = _monthCheck(p.monthKey, 0);
        if (c.reason != uint16(ReasonCode.None)) return c;

        // Settlement moves the reservation out of `p.dayIndex`/`p.monthKey` and into the day and
        // month of execution. When the settle bucket IS the reservation bucket the two cancel and
        // the committed total is unchanged, so the delta must be 0 — passing `p.amount` here
        // would count the payment against itself and refuse every ordinary same-day settlement.
        //
        // When they DIFFER, the settle bucket genuinely grows by `p.amount`, and that growth must
        // be checked against the current limit. This is what stops a reservation parked across a
        // UTC day or month boundary from being spent on top of a separately-filled budget.
        uint256 settleDayKey = Calendar.currentDayIndex();
        uint256 settleMonthKey = Calendar.currentMonthKey();
        c = _dayCheck(settleDayKey, p.dayIndex == settleDayKey ? 0 : p.amount);
        if (c.reason != uint16(ReasonCode.None)) return c;
        return _monthCheck(settleMonthKey, p.monthKey == settleMonthKey ? 0 : p.amount);
    }

    // ---------------------------------------------------------------------
    // Internal: accounting
    // ---------------------------------------------------------------------

    function _reserve(uint256 amount, uint256 dayKey, uint256 monthKey) private {
        reservedDay[dayKey] += amount;
        reservedMonth[monthKey] += amount;
        lifetimeReserved += amount;
    }

    /// @dev Underflows (and therefore reverts) if the accounting is ever inconsistent, which
    ///      makes a drift between reserved and executed impossible to mask.
    function _release(uint256 amount, uint256 dayKey, uint256 monthKey) private {
        reservedDay[dayKey] -= amount;
        reservedMonth[monthKey] -= amount;
        lifetimeReserved -= amount;
    }

    function _revertWithReason(uint256 id, PaymentRequest storage p, CheckResult memory r) private view {
        if (r.reason == uint16(ReasonCode.CallerNotAuthorized)) revert NotAuthorized(msg.sender, OWNER_ROLE);
        if (r.reason == uint16(ReasonCode.NotExecutable)) revert PaymentNotExecutable(id, p.status);
        if (r.reason == uint16(ReasonCode.PaymentNotReserved)) revert PaymentNotReserved(id);
        if (r.reason == uint16(ReasonCode.InvalidRecipient)) revert InvalidRecipient();
        if (r.reason == uint16(ReasonCode.ZeroAmount)) revert ZeroAmount();
        if (r.reason == uint16(ReasonCode.InsufficientBalance)) {
            revert InsufficientBalance(p.amount, asset.balanceOf(address(this)));
        }
        revert PolicyViolation(r.reason, r.limit, r.actual);
    }

    // ---------------------------------------------------------------------
    // Last-admin protection
    // ---------------------------------------------------------------------

    function grantRole(bytes32 role, address account) public virtual override {
        bool becomesAdmin = role == DEFAULT_ADMIN_ROLE && !hasRole(role, account);
        super.grantRole(role, account);
        if (becomesAdmin) _adminCount += 1;
    }

    function revokeRole(bytes32 role, address account) public virtual override {
        bool wasAdmin = role == DEFAULT_ADMIN_ROLE && hasRole(role, account);
        if (wasAdmin && _adminCount <= 1) revert LastAdmin();
        super.revokeRole(role, account);
        if (wasAdmin) _adminCount -= 1;
    }

    function renounceRole(bytes32 role, address callerConfirmation) public virtual override {
        bool wasAdmin = role == DEFAULT_ADMIN_ROLE && hasRole(role, callerConfirmation);
        if (wasAdmin && _adminCount <= 1) revert LastAdmin();
        super.renounceRole(role, callerConfirmation);
        if (wasAdmin) _adminCount -= 1;
    }

    function adminCount() external view returns (uint256) {
        return _adminCount;
    }
}

/// @dev Minimal `decimals()` reader used only in the constructor.
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
