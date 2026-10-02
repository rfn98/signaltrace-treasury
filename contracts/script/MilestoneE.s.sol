// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Treasury} from "../src/Treasury.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @title Milestone E — end-to-end payment execution on Arbitrum Sepolia
/// @notice Executes two REAL payments against the already-deployed Milestone D Treasury and
///         asserts the deterministic policy / accounting / authorisation model survives contact
///         with a live network.
///
/// @dev This script does NOT deploy and does NOT touch the Treasury's logic. It only calls the
///      existing owner/agent/stranger entry points and then reads state back.
///
///      Secret handling: keys are read with `vm.envUint` from the gitignored `.env`, so no key
///      ever reaches a command line. Each identity's key is checked against its configured
///      ADDRESS before use, so a mis-paired key can never sign as the wrong actor.
///
///      Role discipline: the OWNER key is used ONLY for owner operations (mint, addRecipient,
///      approvePayment, execute-of-an-OWNER-approved payment). The AGENT key is used for
///      createPaymentRequest and for executing the AUTO_APPROVED payment. They are separate
///      broadcasts, and each asserts its own key maps to its own address.
///
///      Bucket arithmetic is asserted against the day/month the CONTRACT recorded on each payment
///      (`p.dayIndex` / `p.monthKey`), not against wall-clock day boundaries, so the checks stay
///      correct even if this script straddles a UTC midnight.
contract MilestoneE is Script {
    uint256 internal constant FUND_AMOUNT = 200_000_000; // 200 mUSD
    uint256 internal constant AUTO_AMOUNT = 10_000_000; // 10 mUSD, <= autoApproveLimit
    uint256 internal constant APPROVED_AMOUNT = 50_000_000; // 50 mUSD, > autoApproveLimit
    uint256 internal constant TOTAL_SPENT = AUTO_AMOUNT + APPROVED_AMOUNT;
    // Generous headroom on Arbitrum Sepolia for the three transactions the AGENT signs.
    uint256 internal constant AGENT_GAS_REQUIRED = 0.005 ether;
    // Gas-only native transfer from OWNER to AGENT; unrelated to the 200 mUSD under test.
    uint256 internal constant AGENT_GAS_FUNDING = 0.02 ether;
    // Mint + allowlist + approve + execute the manually approved payment.
    uint256 internal constant OWNER_GAS_REQUIRED = 0.01 ether;

    MockERC20 internal token;
    Treasury internal treasury;
    IERC20 internal asset;

    address internal owner;
    address internal agent;
    address internal stranger;
    address internal recipient;

    uint256 internal ownerKey;
    uint256 internal agentKey;

    /// @dev Day/month buckets observed during the run, so the final total can be asserted across
    ///      however many buckets the run actually touched.
    uint256 internal dayA;
    uint256 internal dayB;
    uint256 internal monthA;
    uint256 internal monthB;

    function run() external {
        _load();

        console2.log("=== MILESTONE E : baseline ===");
        _logBaseline();
        _recordBuckets();

        _step0FundAgentGas();
        _requireGas();

        _step1Fund();
        _step2AddRecipient();
        uint256 autoId = _step3CreateAutoApproved();
        _step6StrangerCheck(autoId);
        _step4ExecuteAsAgent(autoId);
        uint256 approvedId = _step5PendingApprovedExecuted();
        _step7FinalAccounting(autoId, approvedId);
    }

    // -----------------------------------------------------------------
    // Setup / identity verification
    // -----------------------------------------------------------------

    function _load() internal {
        ownerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        agentKey = vm.envUint("AGENT_PRIVATE_KEY");
        owner = vm.envAddress("OWNER_ADDRESS");
        agent = vm.envAddress("AGENT_ADDRESS");
        stranger = vm.envAddress("STRANGER_ADDRESS");
        recipient = vm.envAddress("TEST_RECIPIENT_ADDRESS");
        token = MockERC20(vm.envAddress("TOKEN_ADDRESS"));
        treasury = Treasury(vm.envAddress("TREASURY_ADDRESS"));
        asset = IERC20(vm.envAddress("TOKEN_ADDRESS"));

        require(block.chainid == vm.envOr("CHAIN_ID", uint256(421614)), "wrong chain");
        require(address(treasury.asset()) == address(token), "token/treasury mismatch");
        require(treasury.assetDecimals() == 6, "treasury is not readable / decimals snapshot wrong");

        // A key that does not derive to its configured address would silently act as the wrong
        // identity and make every authorisation assertion below meaningless.
        require(vm.addr(ownerKey) == owner, "owner key/address mismatch");
        require(vm.addr(agentKey) == agent, "agent key/address mismatch");
        require(agent != owner, "agent must differ from owner");
        require(stranger != owner && stranger != agent, "stranger must be distinct");
        require(recipient != owner && recipient != agent && recipient != stranger, "recipient must be distinct");
        require(recipient != address(treasury), "recipient must not be the treasury");
    }

    function _logBaseline() internal view {
        console2.log("chain id            :", block.chainid);
        console2.log("treasury            :", address(treasury));
        console2.log("token               :", address(token));
        console2.log("treasury balance    :", asset.balanceOf(address(treasury)));
        console2.log("recipient balance   :", asset.balanceOf(recipient));
        console2.log("recipientApproved   :", _approved(recipient));
        console2.log("paymentCount        :", treasury.paymentCount());
        console2.log("lifetimeReserved    :", treasury.lifetimeReserved());
        console2.log("lifetimeSpent       :", treasury.lifetimeSpent());
        console2.log("paused              :", treasury.paused());
        console2.log("native owner        :", owner.balance);
        console2.log("native agent        :", agent.balance);
        console2.log("native recipient    :", recipient.balance);

        // Milestone E starts from a clean slate; a non-zero baseline would make every expected
        // total below wrong, so refuse rather than report a confusing delta.
        require(treasury.lifetimeSpent() == 0, "baseline lifetimeSpent must be 0");
        require(treasury.lifetimeReserved() == 0, "baseline lifetimeReserved must be 0");
        require(!treasury.paused(), "treasury must not be paused");
        require(!_approved(recipient), "test recipient must not be pre-allowlisted");
    }

    // -----------------------------------------------------------------
    // Step 0 — give the AGENT gas, then prove each identity can pay for its own txs
    // -----------------------------------------------------------------

    // The AGENT is a locally generated identity and starts with no native ETH, yet it signs two
    // createPaymentRequest calls and one executePayment call. Every identity must pay for its own
    // gas from its own key, so OWNER sends a small gas-only amount to the AGENT address here. This
    // is unrelated to the 200 mUSD under test: it is native ETH, and the OWNER key never signs any
    // AGENT payment transaction.
    function _step0FundAgentGas() internal {
        if (agent.balance >= AGENT_GAS_REQUIRED) {
            console2.log("agent gas           : already funded, no transfer needed");
            return;
        }

        console2.log("=== STEP 0 : fund AGENT gas (owner -> agent, native ETH) ===");
        uint256 before = agent.balance;

        vm.startBroadcast(ownerKey);
        (bool ok,) = payable(agent).call{value: AGENT_GAS_FUNDING}("");
        require(ok, "gas funding transfer failed");
        vm.stopBroadcast();

        console2.log("agent native before :", before);
        console2.log("agent native after  :", agent.balance);
        console2.log("sent (native ETH)   :", AGENT_GAS_FUNDING);
        require(agent.balance > before, "gas funding did not land");
        console2.log("STEP 0 OK");
    }

    function _requireGas() internal view {
        console2.log("gas check agent     :", agent.balance);
        console2.log("gas check owner     :", owner.balance);
        require(agent.balance >= AGENT_GAS_REQUIRED, "AGENT cannot cover its own gas");
        require(owner.balance >= OWNER_GAS_REQUIRED, "OWNER cannot cover its own gas");
    }

    function _recordBuckets() internal {
        dayA = treasury.currentDayIndex();
        monthA = treasury.currentMonthKey();
        dayB = dayA;
        monthB = monthA;
    }

    function _noteBuckets(uint256 day, uint256 month) internal {
        if (day != dayA) dayB = day;
        if (month != monthA) monthB = month;
    }

    // -----------------------------------------------------------------
    // Step 1 — fund the treasury
    // -----------------------------------------------------------------

    function _step1Fund() internal {
        console2.log("=== STEP 1 : fund treasury ===");
        uint256 before = asset.balanceOf(address(treasury));

        // `mint` is the authority path: msg.sender must be MockERC20.faucetAuthority, which is
        // the OWNER on this deployment. Uncapped, unlike `faucet`.
        vm.startBroadcast(ownerKey);
        token.mint(address(treasury), FUND_AMOUNT);
        vm.stopBroadcast();

        uint256 after_ = asset.balanceOf(address(treasury));
        console2.log("minted (owner)      :", FUND_AMOUNT);
        console2.log("balance before      :", before);
        console2.log("balance after       :", after_);
        require(after_ == before + FUND_AMOUNT, "funding did not land as expected");
        console2.log("STEP 1 OK");
    }

    // -----------------------------------------------------------------
    // Step 2 — allowlist the dedicated test recipient
    // -----------------------------------------------------------------

    function _step2AddRecipient() internal {
        console2.log("=== STEP 2 : add test recipient (owner) ===");
        (bool approvedBefore,,) = treasury.recipients(recipient);
        require(!approvedBefore, "recipient already allowlisted");

        vm.startBroadcast(ownerKey);
        treasury.addRecipient(recipient, bytes32("MILESTONE-E"));
        vm.stopBroadcast();

        (bool approved, bytes32 category, uint64 addedAt) = treasury.recipients(recipient);
        console2.log("recipient           :", recipient);
        console2.log("approved            :", approved);
        console2.log("category            :", vm.toString(category));
        console2.log("addedAt             :", uint256(addedAt));
        require(approved, "recipient not approved");
        require(addedAt != 0, "addedAt not stamped");
        console2.log("STEP 2 OK");
    }

    // -----------------------------------------------------------------
    // Step 3 — create an AUTO_APPROVED payment
    // -----------------------------------------------------------------

    function _step3CreateAutoApproved() internal returns (uint256 id) {
        console2.log("=== STEP 3 : create AUTO_APPROVED payment (agent) ===");
        uint256 dayBefore = treasury.currentDayIndex();
        uint256 monthBefore = treasury.currentMonthKey();

        bytes32 paymentRef = keccak256("signaltrace.milestone-e.autoapproved.v1");
        bytes32 category = bytes32("MILESTONE-E");

        (bool previewOk, uint16 previewReason) = treasury.evaluatePayment(recipient, AUTO_AMOUNT);
        console2.log("evaluatePayment ok  :", previewOk);
        console2.log("evaluatePayment rsn :", uint256(previewReason));
        require(previewOk, "creation preview says the payment would be blocked");

        vm.startBroadcast(agentKey);
        id = treasury.createPaymentRequest(recipient, AUTO_AMOUNT, category, paymentRef);
        vm.stopBroadcast();

        (Treasury.PaymentRequest memory p) = _payment(id);
        console2.log("payment id          :", id);
        console2.log("status              :", uint256(p.status), "(2 = AutoApproved)");
        console2.log("amount              :", p.amount);
        console2.log("paymentRef          :", vm.toString(p.paymentRef));
        console2.log("reserved dayIndex   :", p.dayIndex);
        console2.log("reserved monthKey   :", p.monthKey);
        _noteBuckets(p.dayIndex, p.monthKey);

        require(p.status == Treasury.PaymentStatus.AutoApproved, "expected AutoApproved");
        require(p.amount == AUTO_AMOUNT, "amount mismatch");
        require(p.paymentRef == paymentRef, "paymentRef mismatch");

        // The reservation must be live in the buckets the contract itself recorded.
        require(treasury.lifetimeReserved() == AUTO_AMOUNT, "lifetimeReserved wrong");
        require(treasury.reservedDay(p.dayIndex) == AUTO_AMOUNT, "reservedDay wrong");
        require(treasury.reservedMonth(p.monthKey) == AUTO_AMOUNT, "reservedMonth wrong");
        require(treasury.reservedDay(dayBefore) >= AUTO_AMOUNT, "day reservation not in the live day");
        require(treasury.reservedMonth(monthBefore) >= AUTO_AMOUNT, "month reservation not in the live month");

        console2.log("lifetimeReserved    :", treasury.lifetimeReserved());
        console2.log("reservedDay[live]   :", treasury.reservedDay(dayBefore));
        console2.log("reservedMonth[live] :", treasury.reservedMonth(monthBefore));
        console2.log("STEP 3 OK");
    }

    // -----------------------------------------------------------------
    // Step 6 (run here, while the payment is still eligible) — stranger
    // -----------------------------------------------------------------

    /// @dev Uses a low-level call so the revert is CAPTURED instead of aborting the script, and
    ///      runs in simulation only — STRANGER holds no native ETH, and there is no reason to fund
    ///      an account purely to make it burn gas proving a negative.
    function _step6StrangerCheck(uint256 id) internal {
        console2.log("=== STEP 6 : STRANGER attempts to execute ===");
        (Treasury.PaymentRequest memory p) = _payment(id);
        require(p.status == Treasury.PaymentStatus.AutoApproved, "payment must be eligible for this check");

        (bool allowedForStranger, uint16 reasonForStranger) = treasury.canExecute(id, stranger);
        console2.log("canExecute(stranger):", allowedForStranger);
        console2.log("  reason            :", uint256(reasonForStranger));

        (bool allowedForAgent, uint16 reasonForAgent) = treasury.canExecute(id, agent);
        console2.log("canExecute(agent)   :", allowedForAgent);
        console2.log("  reason            :", uint256(reasonForAgent));
        require(allowedForAgent, "agent should be allowed to execute this payment");

        vm.prank(stranger);
        (bool ok, bytes memory ret) =
            address(treasury).call(abi.encodeCall(Treasury.executePayment, (id)));

        require(!ok, "SECURITY FAILURE: stranger was able to execute a payment");
        console2.log("stranger execute    : REVERTED as required");
        if (ret.length >= 4) {
            // Expect NotAuthorized(address,bytes32) from the coarse role gate.
            console2.log("revert selector     :", vm.toString(bytes32(bytes4(ret))));
        }
        require(ret.length >= 4, "expected a custom error");
        require(bytes4(ret) == Treasury.NotAuthorized.selector, "unexpected revert reason");

        // The payment must be untouched by the failed attempt.
        (Treasury.PaymentRequest memory after_) = _payment(id);
        require(after_.status == Treasury.PaymentStatus.AutoApproved, "stranger attempt mutated the payment");
        require(treasury.lifetimeSpent() == 0, "stranger attempt moved the spent counter");
        console2.log("STEP 6 OK");
    }

    // -----------------------------------------------------------------
    // Step 4 — AGENT executes the AUTO_APPROVED payment
    // -----------------------------------------------------------------

    function _step4ExecuteAsAgent(uint256 id) internal {
        console2.log("=== STEP 4 : AGENT executes AUTO_APPROVED payment ===");
        (Treasury.PaymentRequest memory p) = _payment(id);
        uint256 reserveDay = p.dayIndex;
        uint256 reserveMonth = p.monthKey;

        uint256 treBefore = asset.balanceOf(address(treasury));
        uint256 recBefore = asset.balanceOf(recipient);

        vm.startBroadcast(agentKey);
        treasury.executePayment(id);
        vm.stopBroadcast();

        (Treasury.PaymentRequest memory q) = _payment(id);
        uint256 settleDay = treasury.currentDayIndex();
        uint256 settleMonth = treasury.currentMonthKey();
        _noteBuckets(settleDay, settleMonth);

        uint256 treAfter = asset.balanceOf(address(treasury));
        uint256 recAfter = asset.balanceOf(recipient);

        console2.log("status              :", uint256(q.status), "(5 = Executed)");
        console2.log("treasury before/after:", treBefore, "->", treAfter);
        console2.log("recipient before/after:", recBefore, "->", recAfter);
        console2.log("lifetimeSpent       :", treasury.lifetimeSpent());
        console2.log("spentDay[settle]    :", treasury.spentDay(settleDay));
        console2.log("spentMonth[settle]  :", treasury.spentMonth(settleMonth));
        console2.log("reservedDay[reserve]:", treasury.reservedDay(reserveDay));
        console2.log("reservedMonth[res]  :", treasury.reservedMonth(reserveMonth));

        require(q.status == Treasury.PaymentStatus.Executed, "expected Executed");
        require(recAfter - recBefore == AUTO_AMOUNT, "recipient did not receive exactly the amount");
        require(treBefore - treAfter == AUTO_AMOUNT, "treasury did not decrease by exactly the amount");
        require(treasury.lifetimeSpent() == AUTO_AMOUNT, "lifetimeSpent wrong");
        // Reservation released from the buckets the payment was reserved in.
        require(treasury.reservedDay(reserveDay) == 0, "day reservation not released");
        require(treasury.reservedMonth(reserveMonth) == 0, "month reservation not released");
        require(treasury.lifetimeReserved() == 0, "lifetimeReserved should be 0");
        // Settled into the day/month of execution.
        require(treasury.spentDay(settleDay) == AUTO_AMOUNT, "spentDay wrong");
        require(treasury.spentMonth(settleMonth) == AUTO_AMOUNT, "spentMonth wrong");
        console2.log("STEP 4 OK");
    }

    // -----------------------------------------------------------------
    // Step 5 — PENDING -> APPROVED -> EXECUTED, all with OWNER
    // -----------------------------------------------------------------

    function _step5PendingApprovedExecuted() internal returns (uint256 id) {
        console2.log("=== STEP 5 : PENDING -> APPROVED -> EXECUTED ===");
        bytes32 paymentRef = keccak256("signaltrace.milestone-e.approved.v1");
        bytes32 category = bytes32("MILESTONE-E");

        vm.startBroadcast(agentKey);
        id = treasury.createPaymentRequest(recipient, APPROVED_AMOUNT, category, paymentRef);
        vm.stopBroadcast();

        (Treasury.PaymentRequest memory p) = _payment(id);
        console2.log("payment id          :", id);
        console2.log("status after create :", uint256(p.status), "(1 = Pending)");
        require(p.status == Treasury.PaymentStatus.Pending, "expected Pending");
        // A PENDING payment holds no reservation, so nothing is committed yet.
        require(treasury.lifetimeReserved() == 0, "Pending must not reserve");

        // ---- OWNER approves ----
        vm.startBroadcast(ownerKey);
        treasury.approvePayment(id);
        vm.stopBroadcast();

        (Treasury.PaymentRequest memory a) = _payment(id);
        _noteBuckets(a.dayIndex, a.monthKey);
        console2.log("status after approve:", uint256(a.status), "(3 = Approved)");
        console2.log("approvedBy          :", a.approvedBy);
        console2.log("lifetimeReserved    :", treasury.lifetimeReserved());
        require(a.status == Treasury.PaymentStatus.Approved, "expected Approved");
        require(a.approvedBy == owner, "approvedBy must be the OWNER");
        require(treasury.lifetimeReserved() == APPROVED_AMOUNT, "approval must reserve");
        require(treasury.reservedDay(a.dayIndex) == APPROVED_AMOUNT, "reservedDay wrong on approval");
        require(treasury.reservedMonth(a.monthKey) == APPROVED_AMOUNT, "reservedMonth wrong on approval");

        // ---- the authority distinction: an APPROVED payment needs OWNER ----
        (bool agentAllowed, uint16 agentReason) = treasury.canExecute(id, agent);
        console2.log("canExecute(agent)   :", agentAllowed, "reason", uint256(agentReason));
        require(!agentAllowed, "AGENT must NOT be able to execute an OWNER-approved payment");

        // ---- OWNER executes ----
        uint256 recBefore = asset.balanceOf(recipient);
        uint256 treBefore = asset.balanceOf(address(treasury));

        vm.startBroadcast(ownerKey);
        treasury.executePayment(id);
        vm.stopBroadcast();

        (Treasury.PaymentRequest memory e) = _payment(id);
        uint256 settleDay = treasury.currentDayIndex();
        uint256 settleMonth = treasury.currentMonthKey();
        _noteBuckets(settleDay, settleMonth);

        uint256 recAfter = asset.balanceOf(recipient);
        uint256 treAfter = asset.balanceOf(address(treasury));

        console2.log("status after execute:", uint256(e.status), "(5 = Executed)");
        console2.log("recipient before/after:", recBefore, "->", recAfter);
        console2.log("treasury before/after:", treBefore, "->", treAfter);
        console2.log("lifetimeSpent       :", treasury.lifetimeSpent());

        require(e.status == Treasury.PaymentStatus.Executed, "expected Executed");
        require(recAfter - recBefore == APPROVED_AMOUNT, "recipient delta wrong");
        require(treBefore - treAfter == APPROVED_AMOUNT, "treasury delta wrong");
        require(treasury.lifetimeSpent() == TOTAL_SPENT, "lifetimeSpent != 60 mUSD");
        require(treasury.lifetimeReserved() == 0, "lifetimeReserved should be 0");
        require(treasury.reservedDay(a.dayIndex) == 0, "day reservation not released");
        require(treasury.reservedMonth(a.monthKey) == 0, "month reservation not released");
        console2.log("STEP 5 OK");
    }

    // -----------------------------------------------------------------
    // Step 7 — final accounting
    // -----------------------------------------------------------------

    function _step7FinalAccounting(uint256 autoId, uint256 approvedId) internal view {
        console2.log("=== STEP 7 : final on-chain accounting ===");

        uint256 treBal = asset.balanceOf(address(treasury));
        uint256 recBal = asset.balanceOf(recipient);
        console2.log("treasury balance    :", treBal);
        console2.log("recipient balance   :", recBal);
        console2.log("lifetimeReserved    :", treasury.lifetimeReserved());
        console2.log("lifetimeSpent       :", treasury.lifetimeSpent());
        console2.log("paymentCount        :", treasury.paymentCount());

        console2.log("day A               :", dayA);
        console2.log("  reserved/spent    :", treasury.reservedDay(dayA), "/", treasury.spentDay(dayA));
        console2.log("day B               :", dayB);
        console2.log("  reserved/spent    :", treasury.reservedDay(dayB), "/", treasury.spentDay(dayB));
        console2.log("month A             :", monthA);
        console2.log("  reserved/spent    :", treasury.reservedMonth(monthA), "/", treasury.spentMonth(monthA));
        console2.log("month B             :", monthB);
        console2.log("  reserved/spent    :", treasury.reservedMonth(monthB), "/", treasury.spentMonth(monthB));

        require(recBal == TOTAL_SPENT, "recipient must hold exactly 60 mUSD");
        require(treBal == FUND_AMOUNT - TOTAL_SPENT, "treasury must hold 200 - 60 mUSD");
        require(treBal + recBal == FUND_AMOUNT, "tokens not conserved");
        require(treasury.lifetimeSpent() == TOTAL_SPENT, "lifetimeSpent != 60 mUSD");
        require(treasury.lifetimeReserved() == 0, "lifetimeReserved != 0");
        require(treasury.paymentCount() == 2, "expected exactly 2 payments");
        require(!treasury.paused(), "treasury must still be unpaused");
        require(_approved(recipient), "recipient must still be approved");

        // Bucket totals must add up to the lifetime spend across every bucket the run touched.
        // The run may stay inside a single day/month, in which case dayA == dayB and summing both
        // would double-count the same bucket, so each distinct bucket is counted exactly once.
        uint256 dayTotal = treasury.spentDay(dayA);
        if (dayB != dayA) dayTotal += treasury.spentDay(dayB);
        require(dayTotal == TOTAL_SPENT, "day bucket total != lifetimeSpent");

        uint256 monthTotal = treasury.spentMonth(monthA);
        if (monthB != monthA) monthTotal += treasury.spentMonth(monthB);
        require(monthTotal == TOTAL_SPENT, "month bucket total != lifetimeSpent");

        uint256 reservedDayTotal = treasury.reservedDay(dayA);
        if (dayB != dayA) reservedDayTotal += treasury.reservedDay(dayB);
        require(reservedDayTotal == 0, "day reservations left over");

        uint256 reservedMonthTotal = treasury.reservedMonth(monthA);
        if (monthB != monthA) reservedMonthTotal += treasury.reservedMonth(monthB);
        require(reservedMonthTotal == 0, "month reservations left over");

        // Both payments must read back as EXECUTED with the exact intended amounts.
        (Treasury.PaymentRequest memory p1) = _payment(autoId);
        (Treasury.PaymentRequest memory p2) = _payment(approvedId);
        require(p1.status == Treasury.PaymentStatus.Executed && p1.amount == AUTO_AMOUNT, "payment 1 wrong");
        require(p2.status == Treasury.PaymentStatus.Executed && p2.amount == APPROVED_AMOUNT, "payment 2 wrong");

        console2.log("=== MILESTONE E : ALL CHECKS PASSED ===");
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _payment(uint256 id) internal view returns (Treasury.PaymentRequest memory) {
        return treasury.getPayment(id);
    }

    function _approved(address who) internal view returns (bool) {
        (bool ok,,) = treasury.recipients(who);
        return ok;
    }
}
