import { describe, expect, it } from "vitest";
import { buildCreationEvidence, buildExecutionEvidence } from "@/lib/evidence/build";
import { canonicalJson } from "@/lib/evidence/canonical";
import { toJsonSafe } from "@/lib/json";
import { evaluateCreation } from "@/lib/policy/evaluate";
import {
  MIL_E_POLICY,
  PaymentStatus,
  ReasonCode,
  RECIPIENT_MILESTONE_E,
  TREASURY_ADDRESS,
  CHAIN_ID,
} from "@/lib/policy/types";
import { AGENT_ROLE } from "@/lib/policy/evaluate";

const DAY = 20726n;
const MONTH = 24321n;
const RECIPIENT = { approved: true, category: "MILESTONE-E" };

function baseInput() {
  return {
    chainId: CHAIN_ID,
    treasuryAddress: TREASURY_ADDRESS,
    to: RECIPIENT_MILESTONE_E,
    amount: 10_000_000n,
    category: "MILESTONE-E",
    reference: "0xabc",
    policy: MIL_E_POLICY,
    recipient: RECIPIENT,
    counters: {
      reservedDay: {},
      reservedMonth: {},
      spentDay: {},
      spentMonth: {},
      lifetimeReserved: 0n,
      lifetimeSpent: 60_000_000n,
      balance: 140_000_000n,
      paused: false,
    },
    dayKey: DAY,
    monthKey: MONTH,
    observedAtBlockNumber: 314303200n,
    observedAtBlockTimestamp: 1_790_774_100n,
  };
}

describe("buildCreationEvidence", () => {
  it("is deterministic: the same observed state yields the same integrity hash", () => {
    const a = buildCreationEvidence(baseInput());
    const b = buildCreationEvidence(baseInput());
    expect(a.integrityHash).toBe(b.integrityHash);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("changes the hash when the observed state changes", () => {
    const a = buildCreationEvidence(baseInput());
    const b = buildCreationEvidence({ ...baseInput(), amount: 10_000_001n });
    expect(b.integrityHash).not.toBe(a.integrityHash);
  });

  it("changes the hash when the block it was observed at changes", () => {
    const a = buildCreationEvidence(baseInput());
    const b = buildCreationEvidence({ ...baseInput(), observedAtBlockNumber: 314303201n });
    expect(b.integrityHash).not.toBe(a.integrityHash);
  });

  it("carries no wall-clock time — only the supplied block timestamp", () => {
    const e = buildCreationEvidence(baseInput());
    expect(e.observedAtBlockTimestamp).toBe("1790774100");
    expect(e.observedAtBlockNumber).toBe("314303200");
    // Nothing else in the payload may look like a now().
    expect(Object.keys(e)).not.toContain("createdAt");
  });

  it("agrees with the evaluator on the decision and reason", () => {
    const e = buildCreationEvidence(baseInput());
    const r = evaluateCreation(baseInput());
    expect(e.decision.offchainDecision).toBe(r.decision);
    expect(e.decision.reason).toBe(r.reason);
  });

  it("serialises every monetary value as a lossless decimal string", () => {
    const e = buildCreationEvidence(baseInput());
    expect(e.request.amountBaseUnits).toBe("10000000");
    expect(e.policy.singleTxLimit).toBe("100000000");
    expect(e.budget.treasuryBalanceBaseUnits).toBe("140000000");
    expect(typeof e.request.amountBaseUnits).toBe("string");
  });

  it("states the zero-limit semantics explicitly in the evidence", () => {
    const e = buildCreationEvidence(baseInput());
    expect(e.policy.zeroLimitSemantics.autoApproveLimit).toBe("0 means AUTO-APPROVAL DISABLED");
    expect(e.policy.zeroLimitSemantics.singleTxLimit).toBe("0 means UNLIMITED");
  });

  it("scopes the verdict explicitly: auto-approved is not an authorisation to settle", () => {
    const e = buildCreationEvidence(baseInput());
    expect(e.decision.offchainDecision).toBe("AUTO_APPROVED");
    expect(e.decision.authorityNote).toMatch(/not a settlement authorisation/i);
  });

  it("survives a JSON round trip through the existing Prisma-safe helper", () => {
    const e = buildCreationEvidence(baseInput());
    const roundTripped = JSON.parse(JSON.stringify(toJsonSafe(e)));
    expect(roundTripped.integrityHash).toBe(e.integrityHash);
  });

  it("marks the failing check when blocked, with the limit and actual values", () => {
    const e = buildCreationEvidence({ ...baseInput(), amount: 100_000_001n });
    expect(e.decision.offchainDecision).toBe("BLOCKED");
    expect(e.decision.reason).toBe(ReasonCode.SingleTxLimit);
    const failing = e.checks.find((c) => c.id === "SINGLE_TX_LIMIT");
    expect(failing?.outcome).toBe("FAIL");
    expect(failing?.limitBaseUnits).toBe("100000000");
    expect(failing?.actualBaseUnits).toBe("100000001");
  });
});

describe("buildExecutionEvidence", () => {
  function execInput() {
    return {
      chainId: CHAIN_ID,
      treasuryAddress: TREASURY_ADDRESS,
      reference: "0xabc",
      paymentId: 1n,
      payment: {
        id: 1n,
        recipient: RECIPIENT_MILESTONE_E,
        amount: 10_000_000n,
        status: PaymentStatus.AutoApproved,
        dayIndex: DAY,
        monthKey: MONTH,
      },
      caller: "0x523134AbaEd332378158F64EaA14AFBc446b4169",
      callerRoles: new Set([AGENT_ROLE]),
      policy: MIL_E_POLICY,
      counters: baseInput().counters,
      recipient: RECIPIENT,
      currentDayKey: DAY,
      currentMonthKey: MONTH,
      observedAtBlockNumber: 314303200n,
      observedAtBlockTimestamp: 1_790_774_100n,
    };
  }

  it("is deterministic", () => {
    expect(buildExecutionEvidence(execInput()).integrityHash).toBe(
      buildExecutionEvidence(execInput()).integrityHash,
    );
  });

  it("reports the caller's roles separately from whether the status authorises execution", () => {
    const e = buildExecutionEvidence(execInput());
    expect(e.execution.callerIsAgent).toBe(true);
    expect(e.execution.callerIsOwner).toBe(false);
    expect(e.execution.statusAuthorisesExecution).toBe(true);
    expect(e.decision.allowed).toBe(true);
  });

  it("shows the settle-bucket delta is zero for a same-day settlement", () => {
    const e = buildExecutionEvidence(execInput());
    const settle = e.checks.find((c) => c.id === "SETTLE_DAY_LIMIT");
    expect(settle?.outcome).toBe("PASS");
    // The empty day + delta 0 gives actual 0. If the amount were counted against its own
    // day the actual would be 10000000, and every ordinary same-day settlement would fail.
    expect(settle?.actualBaseUnits).toBe("0");
  });

  it("shows a non-zero settle delta when the settle bucket differs from the reservation", () => {
    const e = buildExecutionEvidence({ ...execInput(), currentDayKey: DAY + 1n, currentMonthKey: MONTH + 1n });
    const settle = e.checks.find((c) => c.id === "SETTLE_DAY_LIMIT");
    // Different bucket => the settle day genuinely grows by the amount, so it is checked.
    expect(settle?.actualBaseUnits).toBe("10000000");
  });
});
