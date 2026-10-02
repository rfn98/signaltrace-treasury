// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Treasury} from "../../src/Treasury.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {Calendar} from "../../src/libraries/Calendar.sol";

/// @dev Shared fixture for the Treasury suite.
///      Wires three principals, a funded MockERC20-backed treasury, an allowlist, and a
///      deterministic reference generator so every test is reproducible.
abstract contract TreasuryTestBase is Test {
    // ---- principals ----
    address internal owner;
    address internal agent;
    address internal stranger;

    // ---- contracts ----
    MockERC20 internal asset;
    Treasury internal treasury;

    // ---- allowlist ----
    address internal knownA; // "AWS"
    address internal knownB; // "Contractor A"
    address internal unknownWallet;

    bytes32 internal constant CAT_CLOUD = keccak256("cloud");
    bytes32 internal constant CAT_CONTRACTOR = keccak256("contractor");
    bytes32 internal constant CAT_MISC = keccak256("misc");

    // ---- amounts (6 decimals) ----
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant TREASURY_FUNDING = 50_000 * UNIT;
    uint256 internal constant TREASURY_BALANCE = 50_000 * UNIT;

    // ---- default policy ----
    uint256 internal constant P_SINGLE_TX = 2_000 * UNIT;
    uint256 internal constant P_DAILY = 10_000 * UNIT;
    uint256 internal constant P_MONTHLY = 50_000 * UNIT;
    uint256 internal constant P_AUTO_APPROVE = 1_000 * UNIT;
    bool internal constant P_ALLOW_UNKNOWN = false;

    /// @dev 1788220800 = 2026-09-01T00:00:00Z. Early in a month so that warping forward a few
    ///      weeks crosses a month boundary without needing a huge jump.
    uint256 internal constant BASE_TIME = 1_788_220_800;

    /// @dev Solidity does not allow cross-contract reads of `public constant` state variables,
    ///      so the role ids are recomputed here. `test_RoleConstantsMatchContract` pins these
    ///      to the values the deployed contract actually returns, so they cannot silently drift.
    bytes32 internal constant ROLE_OWNER = keccak256("OWNER_ROLE");
    bytes32 internal constant ROLE_AGENT = keccak256("AGENT_ROLE");

    uint256 private _refCounter;

    // ---- events redeclared for expectEmit ----
    event PaymentRequested(
        uint256 indexed id, bytes32 indexed paymentRef, address indexed recipient, uint256 amount, bytes32 category, uint8 status
    );
    event PaymentApproved(uint256 indexed id, address indexed actor, uint256 amount, uint256 dayIndex, uint256 monthKey);
    event PaymentRejected(
        uint256 indexed id, address indexed actor, bytes32 reason, uint256 releasedAmount, uint256 dayIndex, uint256 monthKey
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

    function setUp() public virtual {
        vm.warp(BASE_TIME);

        owner = makeAddr("owner");
        agent = makeAddr("agent");
        stranger = makeAddr("stranger");
        knownA = makeAddr("knownA");
        knownB = makeAddr("knownB");
        unknownWallet = makeAddr("unknownWallet");

        asset = new MockERC20(address(this));
        treasury = new Treasury(asset, owner, agent);

        _applyDefaultPolicy();
        _seedAllowlist();
        _fundTreasury(TREASURY_FUNDING);
    }

    // ---------------------------------------------------------------------
    // Fixture helpers
    // ---------------------------------------------------------------------

    function _applyDefaultPolicy() internal {
        Treasury.Policy memory p = Treasury.Policy({
            singleTxLimit: P_SINGLE_TX,
            dailyLimit: P_DAILY,
            monthlyLimit: P_MONTHLY,
            autoApproveLimit: P_AUTO_APPROVE,
            allowUnknownRecipients: P_ALLOW_UNKNOWN
        });
        vm.prank(owner);
        treasury.setPolicy(p);
    }

    /// @dev Applies an arbitrary policy as the owner.
    function _setPolicy(
        uint256 singleTxLimit,
        uint256 dailyLimit,
        uint256 monthlyLimit,
        uint256 autoApproveLimit,
        bool allowUnknownRecipients
    ) internal {
        Treasury.Policy memory p = Treasury.Policy({
            singleTxLimit: singleTxLimit,
            dailyLimit: dailyLimit,
            monthlyLimit: monthlyLimit,
            autoApproveLimit: autoApproveLimit,
            allowUnknownRecipients: allowUnknownRecipients
        });
        vm.prank(owner);
        treasury.setPolicy(p);
    }

    function _seedAllowlist() internal {
        vm.startPrank(owner);
        treasury.addRecipient(knownA, CAT_CLOUD);
        treasury.addRecipient(knownB, CAT_CONTRACTOR);
        vm.stopPrank();
    }

    function _fundTreasury(uint256 amount) internal {
        asset.mint(address(treasury), amount);
    }

    /// @dev Deterministic, unique, non-zero payment reference.
    function _nextRef() internal returns (bytes32) {
        unchecked {
            _refCounter += 1;
        }
        return keccak256(abi.encode("signaltrace/payment", _refCounter));
    }

    /// @dev Creates a request as the AGENT and returns its id.
    function _createAsAgent(address to, uint256 amount) internal returns (uint256) {
        vm.prank(agent);
        return treasury.createPaymentRequest(to, amount, CAT_MISC, _nextRef());
    }

    function _status(uint256 id) internal view returns (Treasury.PaymentStatus) {
        return treasury.getPayment(id).status;
    }

    function _payment(uint256 id) internal view returns (Treasury.PaymentRequest memory) {
        return treasury.getPayment(id);
    }

    function _day() internal view returns (uint256) {
        return treasury.currentDayIndex();
    }

    function _month() internal view returns (uint256) {
        return treasury.currentMonthKey();
    }

    /// @dev Creates a request as the agent and returns the `ReasonCode` the treasury itself
    ///      recorded on the `PaymentBlocked` event it emitted. The reason code is only ever
    ///      published as a log, so the log is the source of truth and is decoded here rather
    ///      than re-derived by the test (which would prove nothing).
    /// @param to Recipient for the request.
    /// @param amount Amount for the request.
    /// @return id The new payment id.
    /// @return reason The decoded `ReasonCode`, or `type(uint16).max` if the payment was not
    ///         blocked — a sentinel that cannot collide with a real enum value.
    function _createAndReadBlockReason(address to, uint256 amount) internal returns (uint256 id, uint16 reason) {
        vm.recordLogs();
        id = _createAsAgent(to, amount);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        reason = type(uint16).max;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(treasury) && logs[i].topics[0] == PaymentBlocked.selector) {
                // `PaymentBlocked` indexes only `id` and `recipient`, so the log data is the
                // two-word encoding of (amount, reasonCode). Decoding it as a bare uint16
                // reverts on the extra word.
                (, reason) = abi.decode(logs[i].data, (uint256, uint16));
            }
        }
    }
}
