import type {
  CheckResult,
  EvalOffchainDecision,
  Payment,
  Policy,
  RecipientState,
  TreasuryCounters,
} from "./types";
import { PaymentStatus, ReasonCode, TREASURY_ADDRESS } from "./types";

/**
 * Off-chain mirror of the Treasury policy engine.
 *
 * DESIGN RULE: this module is a TRANSLATION of `contracts/src/Treasury.sol`, not a
 * re-interpretation of it. Every branch below has a named Solidity counterpart and the
 * two must stay in lockstep. Where the contract is surprising, the surprise is preserved
 * rather than "fixed" — the comments say so explicitly.
 *
 * PURITY: pure functions only. No network, no clock, no randomness, no database, no
 * filesystem. Every input is passed in, which is what makes the results reproducible and
 * the evidence hash stable.
 */

const NONE: CheckResult = { reason: ReasonCode.None, limit: 0n, actual: 0n };

/** Lower-cases and normalises an address for comparison, mirroring Solidity's `==`. */
function isSelf(to: string, self: string): boolean {
  return to.toLowerCase() === self.toLowerCase();
}

function isZeroAddress(to: string): boolean {
  return /^0x0{40}$/i.test(to);
}

/**
 * `_corePolicyCheck` (Treasury.sol:598).
 *
 * Per-payment facts only: address validity, allowlist, single-tx limit, balance. It
 * deliberately knows nothing about status or the caller's roles.
 */
function corePolicyCheck(
  to: string,
  amount: bigint,
  policy: Policy,
  recipient: RecipientState,
  balance: bigint,
  self: string = TREASURY_ADDRESS,
): CheckResult {
  if (isZeroAddress(to)) return { reason: ReasonCode.InvalidRecipient, limit: 0n, actual: 0n };
  if (amount === 0n) return { reason: ReasonCode.ZeroAmount, limit: 0n, actual: 0n };
  if (isSelf(to, self)) return { reason: ReasonCode.SelfTransfer, limit: 0n, actual: amount };
  if (!recipient.approved && !policy.allowUnknownRecipients) {
    return { reason: ReasonCode.UnknownRecipient, limit: 0n, actual: amount };
  }
  // Zero-guarded: 0 means UNLIMITED, so a zero must never be read as the tightest limit.
  if (policy.singleTxLimit !== 0n && amount > policy.singleTxLimit) {
    return { reason: ReasonCode.SingleTxLimit, limit: policy.singleTxLimit, actual: amount };
  }
  if (balance < amount) {
    return { reason: ReasonCode.InsufficientBalance, limit: balance, actual: amount };
  }
  return NONE;
}

/**
 * `_dayCheck` (Treasury.sol:631).
 *
 * The limit applies to the SUM of reserved + spent, not to each independently. See the
 * long comment in the contract: bounding them separately lets one day carry 2L of
 * obligations. That is the only safe reading, so it is the one mirrored here.
 */
function dayCheck(
  dayKey: bigint,
  delta: bigint,
  policy: Policy,
  counters: TreasuryCounters,
): CheckResult {
  if (policy.dailyLimit === 0n) return NONE;
  const k = dayKey.toString();
  const total = (counters.reservedDay[k] ?? 0n) + (counters.spentDay[k] ?? 0n) + delta;
  if (total > policy.dailyLimit) {
    return { reason: ReasonCode.DailyLimit, limit: policy.dailyLimit, actual: total };
  }
  return NONE;
}

/** `_monthCheck` (Treasury.sol:642). The civil-month equivalent of `dayCheck`. */
function monthCheck(
  monthKey: bigint,
  delta: bigint,
  policy: Policy,
  counters: TreasuryCounters,
): CheckResult {
  if (policy.monthlyLimit === 0n) return NONE;
  const k = monthKey.toString();
  const total = (counters.reservedMonth[k] ?? 0n) + (counters.spentMonth[k] ?? 0n) + delta;
  if (total > policy.monthlyLimit) {
    return { reason: ReasonCode.MonthlyLimit, limit: policy.monthlyLimit, actual: total };
  }
  return NONE;
}

/**
 * `_creationCheck` (Treasury.sol:652): what a request must pass to be created as
 * `Pending` or `AutoApproved`, evaluated at the CURRENT day/month buckets.
 */
function creationCheck(
  to: string,
  amount: bigint,
  dayKey: bigint,
  monthKey: bigint,
  policy: Policy,
  counters: TreasuryCounters,
  recipient: RecipientState,
  self: string = TREASURY_ADDRESS,
): CheckResult {
  const core = corePolicyCheck(to, amount, policy, recipient, counters.balance, self);
  if (core.reason !== ReasonCode.None) return core;
  const day = dayCheck(dayKey, amount, policy, counters);
  if (day.reason !== ReasonCode.None) return day;
  return monthCheck(monthKey, amount, policy, counters);
}

export type CreationInput = {
  to: string;
  amount: bigint;
  policy: Policy;
  counters: TreasuryCounters;
  recipient: RecipientState;
  /** Bucket the request would be created in. Observed, never inferred. */
  dayKey: bigint;
  monthKey: bigint;
  self?: string;
};

export type CreationResult = {
  /** What `createPaymentRequest` would assign, given the contract agrees with us. */
  decision: EvalOffchainDecision;
  /** True when the request is not `Blocked`. */
  allowed: boolean;
  reason: ReasonCode;
  check: CheckResult;
};

/**
 * The creation-time verdict: `AUTO_APPROVED` | `PENDING` | `BLOCKED`.
 *
 * The auto-approval branch is copied from `createPaymentRequest` (Treasury.sol:402):
 * `autoApproveLimit != 0 && amount <= autoApproveLimit`. Note the asymmetry preserved
 * from the contract — a ZERO `autoApproveLimit` DISABLES auto-approval, whereas a zero
 * `singleTxLimit`/`dailyLimit`/`monthlyLimit` means UNLIMITED. One zero means "no cap",
 * the other means "the feature is off". Collapsing them would be a real bug.
 */
export function evaluateCreation(input: CreationInput): CreationResult {
  const { to, amount, policy, counters, recipient, dayKey, monthKey, self } = input;
  const check = creationCheck(to, amount, dayKey, monthKey, policy, counters, recipient, self);

  if (check.reason !== ReasonCode.None) {
    return { decision: "BLOCKED", allowed: false, reason: check.reason, check };
  }
  const autoApprove = policy.autoApproveLimit !== 0n && amount <= policy.autoApproveLimit;
  return {
    decision: autoApprove ? "AUTO_APPROVED" : "PENDING",
    allowed: true,
    reason: ReasonCode.None,
    check,
  };
}

export type ExecutionInput = {
  payment: Payment;
  caller: string;
  callerRoles: ReadonlySet<string>;
  policy: Policy;
  counters: TreasuryCounters;
  recipient: RecipientState;
  /** Buckets current at the moment of the execution attempt (settle buckets). */
  currentDayKey: bigint;
  currentMonthKey: bigint;
  self?: string;
};

export type ExecutionResult = {
  allowed: boolean;
  reason: ReasonCode;
  check: CheckResult;
};

const OWNER_ROLE = "0xb19546dff01e856fb3f010c267a7b1c60363cf8a4664e21cc89c26224620214e";
const AGENT_ROLE = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";

/**
 * The coarse role gate from `executePayment` (Treasury.sol:484) — the caller must hold
 * AGENT_ROLE or OWNER_ROLE, checked before the fine `_executionCheck`.
 *
 * This is modelled separately because it is a distinct authorization step with a distinct
 * failure (`NotAuthorized` revert) from the fine check's reason codes, and because
 * `canExecute` deliberately does NOT include it (see the divergence note below). Modelling
 * the true execution path is what stops this evaluator from over-claiming that a stranger
 * "can execute" an AutoApproved payment.
 */
export function passesCoarseRoleGate(callerRoles: ReadonlySet<string>): boolean {
  return callerRoles.has(OWNER_ROLE) || callerRoles.has(AGENT_ROLE);
}

/**
 * `_executionCheck` (Treasury.sol:666) plus the `paused` short-circuit that
 * `canExecute` (Treasury.sol:523) applies in front of it.
 *
 * KNOWN DIVERGENCE: `canExecute` runs only `_executionCheck`, so for an AutoApproved payment
 * it can report `allowed=true` even for a caller who would be rejected by the coarse gate
 * in `executePayment` (a stranger, for example). This evaluator models the REAL execution
 * path — coarse gate AND fine check — so it never over-claims. `evaluateCanExecuteView` is
 * provided for anyone who needs to reproduce the on-chain view's (weaker) verdict.
 *
 * The two subtleties that are easy to get wrong and are preserved verbatim:
 *
 *  1. AUTHORITY IS A FUNCTION OF (role, status). `Approved` requires OWNER. `AutoApproved`
 *     permits OWNER *and* AGENT. Any other status is `NotExecutable` regardless of role.
 *  2. SETTLE-BUCKET DELTA. Settlement moves the reservation from the payment's buckets to
 *     the buckets of execution. When those coincide the two cancel and the delta is 0;
 *     when they differ the settle bucket genuinely grows by the amount and that must be
 *     re-checked. Passing the amount unconditionally would count a payment against itself
 *     and refuse every ordinary same-day settlement.
 */
export function evaluateExecution(input: ExecutionInput): ExecutionResult {
  const { payment, callerRoles, policy, counters, recipient, currentDayKey, currentMonthKey, self } = input;

  if (counters.paused) {
    return { allowed: false, reason: ReasonCode.Paused, check: { reason: ReasonCode.Paused, limit: 0n, actual: 0n } };
  }

  // The coarse gate executePayment applies first. For an Approved payment the fine check
  // below demands OWNER specifically; for AutoApproved either role (or the gate) suffices.
  const isOwner = callerRoles.has(OWNER_ROLE);
  const isAgent = callerRoles.has(AGENT_ROLE);
  if (!isOwner && !isAgent) {
    return {
      allowed: false,
      reason: ReasonCode.CallerNotAuthorized,
      check: { reason: ReasonCode.CallerNotAuthorized, limit: 0n, actual: 0n },
    };
  }

  const status = payment.status;
  if (status === PaymentStatus.Approved) {
    if (!callerRoles.has(OWNER_ROLE)) {
      return {
        allowed: false,
        reason: ReasonCode.CallerNotAuthorized,
        check: { reason: ReasonCode.CallerNotAuthorized, limit: 0n, actual: 0n },
      };
    }
  } else if (status !== PaymentStatus.AutoApproved) {
    return {
      allowed: false,
      reason: ReasonCode.NotExecutable,
      check: { reason: ReasonCode.NotExecutable, limit: 0n, actual: 0n },
    };
  }
  // status == AutoApproved: OWNER_ROLE and AGENT_ROLE are both permitted.

  // A zero dayIndex would mean a zero-initialised reservation whose bucket trivially
  // passes the daily check. Refuse it.
  if (payment.dayIndex === 0n) {
    return {
      allowed: false,
      reason: ReasonCode.PaymentNotReserved,
      check: { reason: ReasonCode.PaymentNotReserved, limit: 0n, actual: 0n },
    };
  }

  const core = corePolicyCheck(payment.recipient, payment.amount, policy, recipient, counters.balance, self);
  if (core.reason !== ReasonCode.None) return { allowed: false, reason: core.reason, check: core };

  // The reservation's own buckets must still satisfy the CURRENT policy. This is what
  // makes a policy lowering strand existing reservations, by design.
  const ownDay = dayCheck(payment.dayIndex, 0n, policy, counters);
  if (ownDay.reason !== ReasonCode.None) return { allowed: false, reason: ownDay.reason, check: ownDay };
  const ownMonth = monthCheck(payment.monthKey, 0n, policy, counters);
  if (ownMonth.reason !== ReasonCode.None) return { allowed: false, reason: ownMonth.reason, check: ownMonth };

  const settleDay = dayCheck(
    currentDayKey,
    payment.dayIndex === currentDayKey ? 0n : payment.amount,
    policy,
    counters,
  );
  if (settleDay.reason !== ReasonCode.None) return { allowed: false, reason: settleDay.reason, check: settleDay };

  const settleMonth = monthCheck(
    currentMonthKey,
    payment.monthKey === currentMonthKey ? 0n : payment.amount,
    policy,
    counters,
  );
  if (settleMonth.reason !== ReasonCode.None) {
    return { allowed: false, reason: settleMonth.reason, check: settleMonth };
  }

  return { allowed: true, reason: ReasonCode.None, check: NONE };
}

export { OWNER_ROLE, AGENT_ROLE };
export { corePolicyCheck, dayCheck, monthCheck, creationCheck };
