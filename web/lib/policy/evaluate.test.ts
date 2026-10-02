import { describe, expect, it } from "vitest";
import { evaluateCreation, evaluateExecution, AGENT_ROLE, OWNER_ROLE } from "@/lib/policy/evaluate";
import type { Policy, RecipientState, TreasuryCounters } from "@/lib/policy/types";
import { PaymentStatus, ReasonCode, MIL_E_POLICY, TREASURY_ADDRESS, RECIPIENT_MILESTONE_E, STRANGER_ADDRESS } from "@/lib/policy/types";

/**
 * Table-driven checks that the off-chain engine agrees with Treasury.sol.
 *
 * Every case is anchored to a specific contract rule. The point of the table is that a
 * future edit to the evaluator which changes any of these verdicts has to change this file
 * too, visibly, rather than quietly diverging from the contract.
 */

const DAY = 20726n;
const MONTH = 24321n;

const approvedRecipient: RecipientState = { approved: true, category: "MILESTONE-E" };
const strangerRecipient: RecipientState = { approved: false, category: "0x" };

function counters(over: Partial<TreasuryCounters> = {}): TreasuryCounters {
  return {
    reservedDay: {},
    reservedMonth: {},
    spentDay: {},
    spentMonth: {},
    lifetimeReserved: 0n,
    lifetimeSpent: 0n,
    balance: 140_000_000n,
    paused: false,
    ...over,
  };
}

function create(amount: bigint, over: Partial<Parameters<typeof evaluateCreation>[0]> = {}) {
  return evaluateCreation({
    to: RECIPIENT_MILESTONE_E,
    amount,
    policy: MIL_E_POLICY,
    counters: counters(),
    recipient: approvedRecipient,
    dayKey: DAY,
    monthKey: MONTH,
    ...over,
  });
}

describe("evaluateCreation", () => {
  it("auto-approves a small, allowlisted, affordable amount under the cap", () => {
    const r = create(10_000_000n);
    expect(r.decision).toBe("AUTO_APPROVED");
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe(ReasonCode.None);
  });

  it("returns PENDING for an allowlisted amount above the auto-approve cap but within limits", () => {
    const r = create(50_000_000n);
    expect(r.decision).toBe("PENDING");
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe(ReasonCode.None);
  });

  it("BLOCKS a zero recipient", () => {
    const r = create(1n, { to: "0x0000000000000000000000000000000000000000" });
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.InvalidRecipient);
  });

  it("BLOCKS a zero amount", () => {
    const r = create(0n);
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.ZeroAmount);
  });

  it("BLOCKS a self-transfer to the treasury", () => {
    const r = create(1n, { to: TREASURY_ADDRESS });
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.SelfTransfer);
  });

  it("BLOCKS an unknown recipient when the policy does not allow unknowns", () => {
    const r = create(1n, { to: STRANGER_ADDRESS, recipient: strangerRecipient });
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.UnknownRecipient);
  });

  it("ALLOWS an unknown recipient when the policy permits unknowns", () => {
    const policy: Policy = { ...MIL_E_POLICY, allowUnknownRecipients: true };
    const r = create(1n, { to: STRANGER_ADDRESS, recipient: strangerRecipient, policy });
    expect(r.decision).toBe("AUTO_APPROVED");
    expect(r.reason).toBe(ReasonCode.None);
  });

  it("BLOCKS an amount above the single-tx limit", () => {
    const r = create(100_000_001n);
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.SingleTxLimit);
    expect(r.check.limit).toBe(100_000_000n);
    expect(r.check.actual).toBe(100_000_001n);
  });

  it("BLOCKS when the day total would exceed the daily limit (reserved + spent summed)", () => {
    const r = create(1n, { counters: counters({ spentDay: { [DAY.toString()]: 500_000_000n } }) });
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.DailyLimit);
  });

  it("BLOCKS when the month total would exceed the monthly limit", () => {
    const r = create(1n, { counters: counters({ spentMonth: { [MONTH.toString()]: 2_000_000_000n } }) });
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.MonthlyLimit);
  });

  it("BLOCKS when the treasury balance is insufficient", () => {
    const r = create(50_000_000n, { counters: counters({ balance: 49_999_999n }) });
    expect(r.decision).toBe("BLOCKED");
    expect(r.reason).toBe(ReasonCode.InsufficientBalance);
  });

  it("treats a zero single-tx limit as UNLIMITED, not as the tightest limit", () => {
    const policy: Policy = { ...MIL_E_POLICY, singleTxLimit: 0n };
    const r = create(50_000_000n, { policy });
    expect(r.decision).toBe("PENDING");
    expect(r.reason).toBe(ReasonCode.None);
  });

  it("treats a zero daily limit as UNLIMITED", () => {
    const policy: Policy = { ...MIL_E_POLICY, dailyLimit: 0n };
    const r = create(1n, { policy, counters: counters({ spentDay: { [DAY.toString()]: 9_000_000_000n } }) });
    expect(r.decision).toBe("AUTO_APPROVED");
  });

  it("treats a zero monthly limit as UNLIMITED", () => {
    const policy: Policy = { ...MIL_E_POLICY, monthlyLimit: 0n };
    const r = create(1n, { policy, counters: counters({ spentMonth: { [MONTH.toString()]: 9_000_000_000n } }) });
    expect(r.decision).toBe("AUTO_APPROVED");
  });

  it("treats a zero auto-approve limit as DISABLED, so even a tiny amount is PENDING", () => {
    const policy: Policy = { ...MIL_E_POLICY, autoApproveLimit: 0n };
    const r = create(1n, { policy });
    expect(r.decision).toBe("PENDING");
    expect(r.reason).toBe(ReasonCode.None);
  });

  it("auto-approves exactly at the auto-approve cap (the comparison is <=)", () => {
    const r = create(25_000_000n);
    expect(r.decision).toBe("AUTO_APPROVED");
  });

  it("does not auto-approve one base unit above the cap", () => {
    const r = create(25_000_000n + 1n);
    expect(r.decision).toBe("PENDING");
  });
});

const ownerSet = new Set([OWNER_ROLE]);
const agentSet = new Set([AGENT_ROLE]);
const strangerSet = new Set<string>();

function exec(over: Partial<Parameters<typeof evaluateExecution>[0]> = {}) {
  return evaluateExecution({
    payment: {
      id: 9n,
      recipient: RECIPIENT_MILESTONE_E,
      amount: 10_000_000n,
      status: PaymentStatus.AutoApproved,
      dayIndex: DAY,
      monthKey: MONTH,
    },
    caller: "0x000000000000000000000000000000000000dEaD",
    callerRoles: agentSet,
    policy: MIL_E_POLICY,
    counters: counters(),
    recipient: approvedRecipient,
    currentDayKey: DAY,
    currentMonthKey: MONTH,
    ...over,
  });
}

describe("evaluateExecution", () => {
  it("allows an AGENT to execute an AUTO_APPROVED payment", () => {
    const r = exec();
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe(ReasonCode.None);
  });

  it("allows an OWNER to execute an APPROVED payment", () => {
    const r = exec({
      payment: { ...execPaymentBase(), status: PaymentStatus.Approved },
      callerRoles: ownerSet,
    });
    expect(r.allowed).toBe(true);
  });

  it("refuses an AGENT for an APPROVED payment (authority is a function of role AND status)", () => {
    const r = exec({ payment: { ...execPaymentBase(), status: PaymentStatus.Approved }, callerRoles: agentSet });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(ReasonCode.CallerNotAuthorized);
  });

  it("refuses a role-less stranger at the coarse role gate, even for an AUTO_APPROVED payment", () => {
    // executePayment's coarse gate (hasRole AGENT or OWNER) runs before the fine check, so a
    // stranger is refused with CallerNotAuthorized. This is the case where canExecute's view
    // and real execution diverge; the evaluator models the real path and says "not allowed".
    const r = exec({ callerRoles: strangerSet });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(ReasonCode.CallerNotAuthorized);
  });

  it("returns NotExecutable for a PENDING payment even for an OWNER", () => {
    const r = exec({ payment: { ...execPaymentBase(), status: PaymentStatus.Pending }, callerRoles: ownerSet });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(ReasonCode.NotExecutable);
  });

  it("returns PaymentNotReserved when the day bucket is zero", () => {
    const r = exec({ payment: { ...execPaymentBase(), dayIndex: 0n } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(ReasonCode.PaymentNotReserved);
  });

  it("returns Paused when the treasury is paused, before any status logic", () => {
    const r = exec({ counters: counters({ paused: true }) });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(ReasonCode.Paused);
  });

  it("passes a same-day settlement with delta 0 (the amount is not counted against itself)", () => {
    // Day committed is exactly at the limit, and the reservation bucket equals the settle
    // bucket, so the correct delta is 0 and the payment settles. Counting the amount here
    // would refuse every ordinary same-day settlement.
    const c = counters({ reservedDay: { [DAY.toString()]: 500_000_000n } });
    const r = exec({ counters: c });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe(ReasonCode.None);
  });

  it("refuses a cross-day settlement when the settle day cannot absorb the amount", () => {
    const c = counters({
      reservedDay: { [DAY.toString()]: 0n },
      spentDay: { [(DAY + 1n).toString()]: 500_000_000n },
    });
    const r = exec({ counters: c, currentDayKey: DAY + 1n });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(ReasonCode.DailyLimit);
  });

  it("refuses when a policy lowering strands an existing reservation", () => {
    const c = counters({ reservedDay: { [DAY.toString()]: 500_000_000n } });
    const policy: Policy = { ...MIL_E_POLICY, dailyLimit: 100_000_000n };
    const r = exec({ counters: c, policy });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(ReasonCode.DailyLimit);
  });

  it("accepts an OWNER for an APPROVED payment but an AGENT is refused (role AND status)", () => {
    // Confirms the coarse gate does not paper over the fine status check: OWNER passes both,
    // AGENT passes the coarse gate but fails the fine Approved=>OWNER requirement.
    const owner = exec({ payment: { ...execPaymentBase(), status: PaymentStatus.Approved }, callerRoles: ownerSet });
    const agent = exec({ payment: { ...execPaymentBase(), status: PaymentStatus.Approved }, callerRoles: agentSet });
    expect(owner.allowed).toBe(true);
    expect(agent.allowed).toBe(false);
    expect(agent.reason).toBe(ReasonCode.CallerNotAuthorized);
  });

  function execPaymentBase() {
    return {
      id: 9n,
      recipient: RECIPIENT_MILESTONE_E,
      amount: 10_000_000n,
      status: PaymentStatus.AutoApproved,
      dayIndex: DAY,
      monthKey: MONTH,
    };
  }
});
