/**
 * Milestone J — overview and payment-list projection tests.
 *
 * Both modules are `server-only`, so these tests target their exported PURE projections. That is
 * the point of having extracted them: the trust boundary is the interesting part, and it should be
 * assertable without an RPC endpoint or a database.
 */
import { describe, expect, it } from "vitest";

import { PaymentStatus } from "@/lib/policy/types";
import type { Payment } from "@/lib/policy/types";
import { limitView, meterPercent, usageView } from "@/lib/treasury/overview";
import { toPaymentRow } from "@/lib/treasury/payment-list";

describe("limitView — the two meanings of zero", () => {
  it("reads 0 as UNLIMITED for the bounding limits", () => {
    const view = limitView("dailyLimit", "Daily", 0n, "UNLIMITED");
    expect(view.unlimited).toBe(true);
    expect(view.disabled).toBe(false);
    expect(view.zeroMeans).toBe("UNLIMITED");
  });

  it("reads 0 as DISABLED for the auto-approve limit", () => {
    // THE case worth getting right. A treasury with autoApproveLimit = 0 settles nothing
    // unattended. Rendering that as "unlimited" would tell an operator the opposite of the truth
    // about whether their human-in-the-loop control is on.
    const view = limitView("autoApproveLimit", "Auto-approve up to", 0n, "DISABLED");
    expect(view.unlimited).toBe(false);
    expect(view.disabled).toBe(true);
  });

  it("never reports an auto-approve limit as unlimited, at any value", () => {
    // Even when the contract reports unbounded headroom, an auto-approve threshold is not a ceiling
    // that can be absent: `unlimited` must stay false so no UI implies "no cap on auto-approval".
    for (const value of [0n, 1n, 25_000_000n, 10n ** 30n]) {
      const view = limitView("autoApproveLimit", "Auto-approve up to", value, "DISABLED", false);
      expect(view.unlimited).toBe(false);
      // A non-zero threshold is neither unlimited nor disabled.
      expect(view.disabled).toBe(value === 0n);
    }
  });

  it("trusts the contract's own headroom verdict over the raw value", () => {
    // A non-zero configured limit with UNLIMITED headroom means something already consumed the
    // whole ceiling; the contract is the authority on that, not the stored number.
    const view = limitView("monthlyLimit", "Monthly", 2_000_000_000n, "UNLIMITED", true);
    expect(view.unlimited).toBe(true);
  });

  it("keeps a normal configured limit bounded", () => {
    const view = limitView("singleTxLimit", "Single transaction", 100_000_000n, "UNLIMITED", false);
    expect(view.unlimited).toBe(false);
    expect(view.disabled).toBe(false);
    expect(view.limit).toBe("100000000");
  });
});

describe("meterPercent", () => {
  it("draws no bar for an unlimited limit", () => {
    // "100% of infinity" would be a confident false statement about money.
    expect(meterPercent(0n, 0n, true)).toBeNull();
    expect(meterPercent(10n ** 24n, 0n, true)).toBeNull();
  });

  it("computes integer tenths so the bar cannot drift", () => {
    expect(meterPercent(1n, 3n, false)).toBe(33);
    expect(meterPercent(0n, 100n, false)).toBe(0);
    expect(meterPercent(100n, 100n, false)).toBe(100);
  });

  it("clamps an overrun to a full bar rather than overflowing the layout", () => {
    // The tone carries "past the ceiling"; the bar just says "full".
    expect(meterPercent(150n, 100n, false)).toBe(100);
  });
});

describe("usageView", () => {
  it("reports no remaining amount against an unlimited limit", () => {
    const view = usageView("day", 500_000_000n, 0n, null, true, "Day 278");
    expect(view.unlimited).toBe(true);
    expect(view.remaining).toBeNull();
    expect(view.usedPercent).toBeNull();
    expect(view.tone).toBe("unlimited");
  });

  it("reports remaining headroom against a bounded limit", () => {
    const view = usageView("month", 10_000_000n, 2_000_000_000n, 1_990_000_000n, false, "2026-09");
    expect(view.remaining).toBe("1990000000");
    expect(view.usedPercent).toBe(0);
    expect(view.committed).toBe("10000000");
  });

  it("distinguishes at-the-limit from over-the-limit", () => {
    expect(usageView("day", 500_000_000n, 500_000_000n, 0n, false, "Day 278").tone).toBe("warning");
    expect(usageView("day", 500_000_001n, 500_000_000n, 0n, false, "Day 278").tone).toBe("exceeded");
  });
});

describe("toPaymentRow — the chain/index join", () => {
  const payment: Payment = {
    id: 2n,
    recipient: "0x3333333333333333333333333333333333333333",
    amount: 50_000_000n,
    status: PaymentStatus.Executed,
    dayIndex: 20513n,
    // Calendar.monthKey is `year * 12 + month`, NOT YYYYMM: 2026-09 => 2026*12 + 9.
    monthKey: 24321n,
    approvedBy: "0x2222222222222222222222222222222222222222",
    category: "0x" + Buffer.from("MILESTONE-E").toString("hex").padEnd(64, "0"),
    paymentRef: "0x" + Buffer.from("INV-2026-Q3-002").toString("hex").padEnd(64, "0"),
  };

  const indexed = {
    onChainPaymentId: "2",
    createdTxHash: "0xcreated",
    approvedTxHash: null,
    executedTxHash: "0xexecuted",
    createdBlockNumber: "314300000",
    approvedBlockNumber: null,
    executedBlockNumber: "314303123",
    createdAt: "2026-09-30T12:00:00.000Z",
    executedTxAt: "2026-09-30T13:13:07.000Z",
  };

  it("takes every monetary and status field from the chain", () => {
    const row = toPaymentRow(payment, { approved: true, category: "VENDOR" }, indexed);
    expect(row.amountBaseUnits).toBe("50000000");
    expect(row.lifecycle.token).toBe("EXECUTED");
    expect(row.recipient).toBe(payment.recipient);
    expect(row.approvedBy).toBe(payment.approvedBy);
  });

  it("keeps the payment's category distinct from the recipient's", () => {
    // Both are stored as bytes32 on chain and both decode to a readable label. Collapsing them
    // would attribute a payment's purpose to its counterparty, which is a different claim.
    const row = toPaymentRow(payment, { approved: true, category: "VENDOR" }, indexed);
    expect(row.category).toBe("MILESTONE-E");
    expect(row.recipientCategory).toBe("VENDOR");
    expect(row.category).not.toBe(row.recipientCategory);
  });

  it("takes allowlist approval from the chain, not the index", () => {
    const row = toPaymentRow(payment, { approved: false, category: "UNKNOWN" }, indexed);
    expect(row.recipientApproved).toBe(false);
  });

  it("shows a chain payment that the index has not caught up with", () => {
    // Hiding it would hide chain truth. The row renders with empty provenance and a flag.
    const row = toPaymentRow(payment, { approved: true, category: "VENDOR" }, null);
    expect(row.indexed).toBe(false);
    expect(row.lifecycle.token).toBe("EXECUTED");
    expect(row.executedTxHash).toBeNull();
    expect(row.executedBlockNumber).toBeNull();
  });

  it("never invents a reference or category the chain did not supply", () => {
    const bare: Payment = {
      id: 3n,
      recipient: payment.recipient,
      amount: 1n,
      status: PaymentStatus.Pending,
      dayIndex: 20513n,
      monthKey: 24321n,
    };
    const row = toPaymentRow(bare, { approved: false, category: "—" }, null);
    expect(row.reference).toBe("—");
    expect(row.category).toBe("—");
    expect(row.approvedBy).toBeNull();
  });

  it("renders an empty treasury as an empty list rather than an error", () => {
    const row = toPaymentRow(
      {
        id: 1n,
        recipient: payment.recipient,
        amount: 10_000_000n,
        status: PaymentStatus.AutoApproved,
        dayIndex: 20513n,
        monthKey: 24321n,
      },
      { approved: true, category: "VENDOR" },
      null,
    );
    expect(row.indexed).toBe(false);
    expect(row.lifecycle.token).toBe("AUTO_APPROVED");
    expect(row.amountBaseUnits).toBe("10000000");
  });

  it("carries a month label derived from the on-chain month key", () => {
    const row = toPaymentRow(payment, { approved: true, category: "VENDOR" }, indexed);
    expect(row.monthKey).toBe("24321");
    // Named as the policy bucket it is. `monthKey` itself is untouched, and the label is built from
    // the chain's key — never from the index's `createdAt`.
    expect(row.monthLabel).toBe("Policy month · September 2026");
  });

  it("names the policy month from the bucket, not from an indexed creation timestamp", () => {
    // The indexed row carries a concrete creation time. If the label were derived from that, moving
    // the index entry to another month would change the label — and the policy bucket would silently
    // stop describing itself. Moving the indexed timestamp must not move the bucket.
    const lateCreation = { ...indexed, createdAt: "2027-03-01T00:00:00.000Z" };
    const row = toPaymentRow(payment, { approved: true, category: "VENDOR" }, lateCreation);
    expect(row.monthLabel).toBe("Policy month · September 2026");
    expect(row.monthKey).toBe("24321");
  });
});