import { canonicalJson, evidenceHash } from "./canonical";
import type { CreationInput, ExecutionInput } from "@/lib/policy/evaluate";
import { evaluateCreation, evaluateExecution } from "@/lib/policy/evaluate";
import { monthKeyToYearMonth } from "@/lib/policy/calendar";
import { PaymentStatus, ReasonCode } from "@/lib/policy/types";
import type { TreasuryCounters } from "@/lib/policy/types";

/**
 * Policy evidence: a self-contained, hashable record of WHY a decision was made.
 *
 * The point of an evidence object is that it can be shown to somebody who does not trust
 * the decision and who cannot re-run this code. So it carries the inputs, every check that
 * ran, the reason, and a digest over all of it.
 *
 * DETERMINISM: the only timestamp is `observedAtBlockTimestamp`, supplied by the caller
 * from a block they actually read. There is no `Date.now()` anywhere in this module — if
 * the wall clock entered the evidence, two runs over the same chain state would produce
 * different digests and the hash would prove nothing.
 */

export type EvidenceCheck = {
  id: string;
  label: string;
  outcome: "PASS" | "FAIL" | "SKIPPED";
  /** Only present when the check failed, and equal to the contract's ReasonCode. */
  reason?: ReasonCode;
  /** The limit that was breached, decimal string. `null` when not a limit comparison. */
  limitBaseUnits: string | null;
  /** The value that was compared against it. `null` when not a limit comparison. */
  actualBaseUnits: string | null;
};

export type Evidence = {
  schemaVersion: "signaltrace.evidence/v1";
  chainId: number;
  treasuryAddress: string;
  /** Block whose state produced this evidence. The only notion of time in the object. */
  observedAtBlockTimestamp: string;
  observedAtBlockNumber: string;
  policy: {
    singleTxLimit: string;
    dailyLimit: string;
    monthlyLimit: string;
    autoApproveLimit: string;
    allowUnknownRecipients: boolean;
    /** Spelled out because it is the single easiest thing to mirror wrongly. */
    zeroLimitSemantics: {
      singleTxLimit: "0 means UNLIMITED";
      dailyLimit: "0 means UNLIMITED";
      monthlyLimit: "0 means UNLIMITED";
      autoApproveLimit: "0 means AUTO-APPROVAL DISABLED";
    };
  };
  request: {
    to: string;
    amountBaseUnits: string;
    category: string;
    reference: string;
  };
  recipient: {
    address: string;
    approved: boolean;
    category: string;
  };
  budget: {
    dayIndex: string;
    monthKey: string;
    monthKeyLabel: string;
    dayCommittedBefore: string;
    dayCommittedAfter: string;
    monthCommittedBefore: string;
    monthCommittedAfter: string;
    dailyLimit: string;
    monthlyLimit: string;
    treasuryBalanceBaseUnits: string;
  };
  decision: {
    offchainDecision: "AUTO_APPROVED" | "PENDING" | "BLOCKED";
    /** The Solidity ReasonCode the contract would report. 0 = None. */
    reason: ReasonCode;
    reasonName: keyof typeof ReasonCode;
    /** True when the request is not Blocked. */
    allowed: boolean;
    /**
     * Explicitly scoped. The contract assigns this status; it does not authorise
     * settlement, and an AUTO_APPROVED verdict is not an assertion that any particular
     * caller may execute it.
     */
    authorityNote: string;
  };
  checks: EvidenceCheck[];
  /** sha256 over the canonical JSON of this object, excluding this field. */
  integrityHash: string;
};

const REASON_NAMES: Record<ReasonCode, keyof typeof ReasonCode> = {
  [ReasonCode.None]: "None",
  [ReasonCode.InvalidRecipient]: "InvalidRecipient",
  [ReasonCode.ZeroAmount]: "ZeroAmount",
  [ReasonCode.SelfTransfer]: "SelfTransfer",
  [ReasonCode.UnknownRecipient]: "UnknownRecipient",
  [ReasonCode.SingleTxLimit]: "SingleTxLimit",
  [ReasonCode.DailyLimit]: "DailyLimit",
  [ReasonCode.MonthlyLimit]: "MonthlyLimit",
  [ReasonCode.InsufficientBalance]: "InsufficientBalance",
  [ReasonCode.Paused]: "Paused",
  [ReasonCode.CallerNotAuthorized]: "CallerNotAuthorized",
  [ReasonCode.PaymentNotReserved]: "PaymentNotReserved",
  [ReasonCode.NotExecutable]: "NotExecutable",
} as Record<ReasonCode, keyof typeof ReasonCode>;

function committed(counters: TreasuryCounters, kind: "day" | "month", key: bigint): bigint {
  const k = key.toString();
  const r = kind === "day" ? counters.reservedDay[k] : counters.reservedMonth[k];
  const s = kind === "day" ? counters.spentDay[k] : counters.spentMonth[k];
  return (r ?? 0n) + (s ?? 0n);
}

export type BuildCreationEvidenceInput = CreationInput & {
  chainId: number;
  treasuryAddress: string;
  category: string;
  reference: string;
  observedAtBlockNumber: bigint;
  observedAtBlockTimestamp: bigint;
};

const AUTHORITY_NOTE =
  "Off-chain evaluation of OBSERVED state only. AUTO_APPROVED means the request would not be Blocked under the state recorded here; it is not a settlement authorisation and does not assert that any caller can execute it.";

function creationChecks(input: BuildCreationEvidenceInput): EvidenceCheck[] {
  const { to, amount, policy, counters, recipient, dayKey, monthKey: mKey } = input;
  const checks: EvidenceCheck[] = [];
  const add = (
    id: string,
    label: string,
    passed: boolean,
    reason?: ReasonCode,
    limit?: bigint,
    actual?: bigint,
  ): void => {
    checks.push({
      id,
      label,
      outcome: passed ? "PASS" : "FAIL",
      ...(reason !== undefined && !passed ? { reason } : {}),
      limitBaseUnits: limit === undefined ? null : limit.toString(10),
      actualBaseUnits: actual === undefined ? null : actual.toString(10),
    });
  };

  add("RECIPIENT_PRESENT", "Recipient address is non-zero", !/^0x0{40}$/i.test(to), ReasonCode.InvalidRecipient);
  add("AMOUNT_NON_ZERO", "Amount is greater than zero", amount !== 0n, ReasonCode.ZeroAmount);
  add(
    "NOT_SELF_TRANSFER",
    "Recipient is not the treasury itself",
    to.toLowerCase() !== input.treasuryAddress.toLowerCase(),
    ReasonCode.SelfTransfer,
  );
  add(
    "RECIPIENT_ALLOWLISTED",
    policy.allowUnknownRecipients
      ? "Unknown recipients are permitted by policy"
      : "Recipient is on the allowlist",
    recipient.approved || policy.allowUnknownRecipients,
    ReasonCode.UnknownRecipient,
  );
  add(
    "SINGLE_TX_LIMIT",
    policy.singleTxLimit === 0n
      ? "Single-transaction limit is unlimited (0)"
      : "Amount is within the single-transaction limit",
    policy.singleTxLimit === 0n || amount <= policy.singleTxLimit,
    ReasonCode.SingleTxLimit,
    policy.singleTxLimit,
    amount,
  );
  add(
    "TREASURY_BALANCE",
    "Treasury holds enough of the asset",
    counters.balance >= amount,
    ReasonCode.InsufficientBalance,
    counters.balance,
    amount,
  );
  const dayBefore = committed(counters, "day", dayKey);
  const dayAfter = dayBefore + amount;
  add(
    "DAILY_LIMIT",
    policy.dailyLimit === 0n
      ? "Daily limit is unlimited (0)"
      : "Day committed total (reserved + spent + amount) is within the daily limit",
    policy.dailyLimit === 0n || dayAfter <= policy.dailyLimit,
    ReasonCode.DailyLimit,
    policy.dailyLimit,
    dayAfter,
  );
  const monthBefore = committed(counters, "month", mKey);
  const monthAfter = monthBefore + amount;
  add(
    "MONTHLY_LIMIT",
    policy.monthlyLimit === 0n
      ? "Monthly limit is unlimited (0)"
      : "Month committed total (reserved + spent + amount) is within the monthly limit",
    policy.monthlyLimit === 0n || monthAfter <= policy.monthlyLimit,
    ReasonCode.MonthlyLimit,
    policy.monthlyLimit,
    monthAfter,
  );
  add(
    "AUTO_APPROVE_LIMIT",
    policy.autoApproveLimit === 0n
      ? "Auto-approval is disabled (0), so the request is PENDING"
      : "Amount is within the auto-approval limit",
    policy.autoApproveLimit !== 0n && amount <= policy.autoApproveLimit,
    undefined,
    policy.autoApproveLimit,
    amount,
  );

  return checks;
}

/** Builds the evidence record for a creation-time decision. Pure and deterministic. */
export function buildCreationEvidence(input: BuildCreationEvidenceInput): Evidence {
  const result = evaluateCreation(input);
  const checks = creationChecks(input);

  const body = {
    schemaVersion: "signaltrace.evidence/v1" as const,
    chainId: input.chainId,
    treasuryAddress: input.treasuryAddress,
    observedAtBlockTimestamp: input.observedAtBlockTimestamp.toString(10),
    observedAtBlockNumber: input.observedAtBlockNumber.toString(10),
    policy: {
      singleTxLimit: input.policy.singleTxLimit.toString(10),
      dailyLimit: input.policy.dailyLimit.toString(10),
      monthlyLimit: input.policy.monthlyLimit.toString(10),
      autoApproveLimit: input.policy.autoApproveLimit.toString(10),
      allowUnknownRecipients: input.policy.allowUnknownRecipients,
      zeroLimitSemantics: {
        singleTxLimit: "0 means UNLIMITED" as const,
        dailyLimit: "0 means UNLIMITED" as const,
        monthlyLimit: "0 means UNLIMITED" as const,
        autoApproveLimit: "0 means AUTO-APPROVAL DISABLED" as const,
      },
    },
    request: {
      to: input.to,
      amountBaseUnits: input.amount.toString(10),
      category: input.category,
      reference: input.reference,
    },
    recipient: {
      address: input.to,
      approved: input.recipient.approved,
      category: input.recipient.category,
    },
    budget: {
      dayIndex: input.dayKey.toString(10),
      monthKey: input.monthKey.toString(10),
      monthKeyLabel: monthKeyToYearMonth(input.monthKey),
      dayCommittedBefore: committed(input.counters, "day", input.dayKey).toString(10),
      dayCommittedAfter: dayAfterOf(input).toString(10),
      monthCommittedBefore: committed(input.counters, "month", input.monthKey).toString(10),
      monthCommittedAfter: monthAfterOf(input).toString(10),
      dailyLimit: input.policy.dailyLimit.toString(10),
      monthlyLimit: input.policy.monthlyLimit.toString(10),
      treasuryBalanceBaseUnits: input.counters.balance.toString(10),
    },
    decision: {
      offchainDecision: result.decision,
      reason: result.reason,
      reasonName: REASON_NAMES[result.reason],
      allowed: result.allowed,
      authorityNote: AUTHORITY_NOTE,
    },
    checks,
  };

  return { ...body, integrityHash: evidenceHash(body) };
}

function dayAfterOf(input: BuildCreationEvidenceInput): bigint {
  return committed(input.counters, "day", input.dayKey) + input.amount;
}
function monthAfterOf(input: BuildCreationEvidenceInput): bigint {
  return committed(input.counters, "month", input.monthKey) + input.amount;
}

export type BuildExecutionEvidenceInput = ExecutionInput & {
  chainId: number;
  treasuryAddress: string;
  reference: string;
  paymentId: bigint;
  observedAtBlockNumber: bigint;
  observedAtBlockTimestamp: bigint;
};

export type ExecutionEvidence = Evidence & {
  execution: {
    paymentId: string;
    onChainStatus: keyof typeof import("@/lib/policy/types").PaymentStatus;
    caller: string;
    callerIsOwner: boolean;
    callerIsAgent: boolean;
    statusAuthorisesExecution: boolean;
    settleDayKey: string;
    settleMonthKey: string;
  };
};

const EXEC_AUTHORITY_NOTE =
  "Mirrors the contract's _executionCheck: authority is a function of (role, status). A true verdict means this exact payment would pass the checks observed at this block; it is not a submission or a settlement instruction.";

export function buildExecutionEvidence(input: BuildExecutionEvidenceInput): ExecutionEvidence {
  const result = evaluateExecution(input);
  const p = input.payment;
  const OWNER = "0xb19546dff01e856fb3f010c267a7b1c60363cf8a4664e21cc89c26224620214e";
  const AGENT = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";

  const body = {
    schemaVersion: "signaltrace.evidence/v1" as const,
    chainId: input.chainId,
    treasuryAddress: input.treasuryAddress,
    observedAtBlockTimestamp: input.observedAtBlockTimestamp.toString(10),
    observedAtBlockNumber: input.observedAtBlockNumber.toString(10),
    policy: {
      singleTxLimit: input.policy.singleTxLimit.toString(10),
      dailyLimit: input.policy.dailyLimit.toString(10),
      monthlyLimit: input.policy.monthlyLimit.toString(10),
      autoApproveLimit: input.policy.autoApproveLimit.toString(10),
      allowUnknownRecipients: input.policy.allowUnknownRecipients,
      zeroLimitSemantics: {
        singleTxLimit: "0 means UNLIMITED" as const,
        dailyLimit: "0 means UNLIMITED" as const,
        monthlyLimit: "0 means UNLIMITED" as const,
        autoApproveLimit: "0 means AUTO-APPROVAL DISABLED" as const,
      },
    },
    request: {
      to: p.recipient,
      amountBaseUnits: p.amount.toString(10),
      category: p.category ?? "",
      reference: input.reference,
    },
    recipient: {
      address: p.recipient,
      approved: input.recipient.approved,
      category: input.recipient.category,
    },
    budget: {
      dayIndex: p.dayIndex.toString(10),
      monthKey: p.monthKey.toString(10),
      monthKeyLabel: monthKeyToYearMonth(p.monthKey),
      dayCommittedBefore: committed(input.counters, "day", p.dayIndex).toString(10),
      dayCommittedAfter: committed(input.counters, "day", p.dayIndex).toString(10),
      monthCommittedBefore: committed(input.counters, "month", p.monthKey).toString(10),
      monthCommittedAfter: committed(input.counters, "month", p.monthKey).toString(10),
      dailyLimit: input.policy.dailyLimit.toString(10),
      monthlyLimit: input.policy.monthlyLimit.toString(10),
      treasuryBalanceBaseUnits: input.counters.balance.toString(10),
    },
    decision: {
      offchainDecision: result.allowed ? ("PENDING" as const) : ("BLOCKED" as const),
      reason: result.reason,
      reasonName: REASON_NAMES[result.reason],
      allowed: result.allowed,
      authorityNote: EXEC_AUTHORITY_NOTE,
    },
    checks: execChecks(input),
    execution: {
      paymentId: input.paymentId.toString(10),
      onChainStatus: paymentStatusName(p.status),
      caller: input.caller,
      callerIsOwner: input.callerRoles.has(OWNER),
      callerIsAgent: input.callerRoles.has(AGENT),
      statusAuthorisesExecution: p.status === 3 || p.status === 2,
      settleDayKey: input.currentDayKey.toString(10),
      settleMonthKey: input.currentMonthKey.toString(10),
    },
  };

  return { ...body, integrityHash: evidenceHash(body) } as ExecutionEvidence;
}

function paymentStatusName(status: number): keyof typeof PaymentStatus {
  const map = ["None", "Pending", "AutoApproved", "Approved", "Rejected", "Executed", "Blocked"] as const;
  return map[status] ?? "None";
}

/**
 * The per-check breakdown for an execution verdict.
 *
 * `statusAuthorisesExecution` is deliberately separate from the caller's roles: the
 * contract's rule is that authority is a function of (role, status), and a caller can hold
 * OWNER and still be refused a `Pending` payment. Collapsing the two into one "is allowed"
 * flag would hide exactly the distinction that matters.
 */
function execChecks(input: BuildExecutionEvidenceInput): EvidenceCheck[] {
  const { payment: p, policy, counters, recipient, currentDayKey, currentMonthKey } = input;
  const checks: EvidenceCheck[] = [];
  const add = (id: string, label: string, passed: boolean, reason?: ReasonCode, limit?: bigint, actual?: bigint) => {
    checks.push({
      id,
      label,
      outcome: passed ? "PASS" : "FAIL",
      ...(reason !== undefined && !passed ? { reason } : {}),
      limitBaseUnits: limit === undefined ? null : limit.toString(10),
      actualBaseUnits: actual === undefined ? null : actual.toString(10),
    });
  };
  add("NOT_PAUSED", "Treasury is not paused", !counters.paused, ReasonCode.Paused);
  add(
    "STATUS_EXECUTABLE",
    "Payment status is Approved or AutoApproved",
    p.status === PaymentStatus.AutoApproved || p.status === PaymentStatus.Approved,
    ReasonCode.NotExecutable,
  );
  add("PAYMENT_RESERVED", "Payment carries a non-zero reservation day bucket", p.dayIndex !== 0n, ReasonCode.PaymentNotReserved);
  add("RECIPIENT_ALLOWLISTED", "Recipient is on the allowlist or unknowns are allowed", recipient.approved || policy.allowUnknownRecipients, ReasonCode.UnknownRecipient);
  add("SINGLE_TX_LIMIT", "Amount is within the single-transaction limit", policy.singleTxLimit === 0n || p.amount <= policy.singleTxLimit, ReasonCode.SingleTxLimit, policy.singleTxLimit, p.amount);
  add("TREASURY_BALANCE", "Treasury holds enough of the asset", counters.balance >= p.amount, ReasonCode.InsufficientBalance, counters.balance, p.amount);
  add("RESERVATION_DAY_STILL_LEGAL", "The reservation's own day bucket still satisfies the current daily limit", policy.dailyLimit === 0n || committed(counters, "day", p.dayIndex) <= policy.dailyLimit, ReasonCode.DailyLimit, policy.dailyLimit, committed(counters, "day", p.dayIndex));
  add("RESERVATION_MONTH_STILL_LEGAL", "The reservation's own month bucket still satisfies the current monthly limit", policy.monthlyLimit === 0n || committed(counters, "month", p.monthKey) <= policy.monthlyLimit, ReasonCode.MonthlyLimit, policy.monthlyLimit, committed(counters, "month", p.monthKey));
  const dayDelta = p.dayIndex === currentDayKey ? 0n : p.amount;
  add("SETTLE_DAY_LIMIT", "Settling into the current day stays within the daily limit (delta 0 when buckets coincide)", policy.dailyLimit === 0n || committed(counters, "day", currentDayKey) + dayDelta <= policy.dailyLimit, ReasonCode.DailyLimit, policy.dailyLimit, committed(counters, "day", currentDayKey) + dayDelta);
  const monthDelta = p.monthKey === currentMonthKey ? 0n : p.amount;
  add("SETTLE_MONTH_LIMIT", "Settling into the current month stays within the monthly limit (delta 0 when buckets coincide)", policy.monthlyLimit === 0n || committed(counters, "month", currentMonthKey) + monthDelta <= policy.monthlyLimit, ReasonCode.MonthlyLimit, policy.monthlyLimit, committed(counters, "month", currentMonthKey) + monthDelta);
  return checks;
}

export { canonicalJson, evidenceHash };
