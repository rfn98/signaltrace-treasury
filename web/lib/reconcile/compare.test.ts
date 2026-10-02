import { describe, expect, it } from "vitest";
import { reconcile, type DbSnapshot } from "@/lib/reconcile/compare";
import { cmp, summarise } from "@/lib/reconcile/types";
import type { ChainSnapshot } from "@/lib/chain/adapter";
import { PaymentStatus, MIL_E_POLICY, TREASURY_ADDRESS, RECIPIENT_MILESTONE_E, TOKEN_ADDRESS } from "@/lib/policy/types";

/**
 * Reconciliation is a pure function of (chain snapshot, db snapshot), so it is tested with
 * fixtures rather than a live node. A separate live test (network-gated) exercises the real
 * adapter. What matters here is the classification logic: MATCH / MISMATCH / UNAVAILABLE.
 */

function chainSnapshot(over: Partial<ChainSnapshot> = {}): ChainSnapshot {
  return {
    chainId: 421614,
    blockNumber: 314303200n,
    blockTimestamp: 1_790_774_100n,
    treasuryAddress: TREASURY_ADDRESS,
    assetAddress: TOKEN_ADDRESS,
    assetDecimals: 6,
    policy: MIL_E_POLICY,
    counters: {
      reservedDay: {},
      reservedMonth: {},
      spentDay: { "20726": 60_000_000n },
      spentMonth: { "24321": 60_000_000n },
      lifetimeReserved: 0n,
      lifetimeSpent: 60_000_000n,
      balance: 140_000_000n,
      paused: false,
    },
    paymentCount: 1n,
    payments: [
      {
        id: 1n,
        recipient: RECIPIENT_MILESTONE_E,
        amount: 10_000_000n,
        status: PaymentStatus.Executed,
        dayIndex: 20726n,
        monthKey: 24321n,
        approvedBy: null,
      },
    ],
    ...over,
  };
}

function dbSnapshot(over: Partial<DbSnapshot> = {}): DbSnapshot {
  return {
    treasuryAddress: TREASURY_ADDRESS,
    ownerAddress: "0xfcdf7Cfa55d371675E65E9bdc7546F6B85B2730e",
    agentAddress: "0x523134AbaEd332378158F64EaA14AFBc446b4169",
    paused: false,
    recipients: [{ address: RECIPIENT_MILESTONE_E, approved: true, category: "MILESTONE-E" }],
    payments: [
      {
        onChainPaymentId: 1n,
        amountBaseUnits: 10_000_000n,
        status: "EXECUTED",
        dayIndex: 20726,
        monthKey: 24321,
        reference: "0xabc",
        recipientAddress: RECIPIENT_MILESTONE_E,
        createdTxHash: "0xdead",
        createdBlockNumber: 314303123n,
        executedTxHash: "0xbeef",
        executedBlockNumber: 314303136n,
      },
    ],
    ...over,
  };
}

describe("reconcile", () => {
  it("reports overall MATCH and zero mismatches for a fully consistent pair", () => {
    const r = reconcile(chainSnapshot(), dbSnapshot());
    const amount = r.fields.find((f) => f.field === "payment[1].amountBaseUnits");
    const status = r.fields.find((f) => f.field === "payment[1].status");
    expect(amount?.verdict).toBe("MATCH");
    expect(status?.verdict).toBe("MATCH");
    expect(r.summary.mismatch).toBe(0);
    expect(r.overall).toBe("MATCH");
  });

  it("flags a payment amount divergence as MISMATCH and overall MISMATCH", () => {
    const r = reconcile(
      chainSnapshot(),
      dbSnapshot({
        payments: [{ ...dbSnapshot().payments[0], amountBaseUnits: 99n }],
      }),
    );
    const f = r.fields.find((x) => x.field === "payment[1].amountBaseUnits");
    expect(f?.verdict).toBe("MISMATCH");
    expect(f?.offchain).toBe("99");
    expect(f?.onchain).toBe("10000000");
    expect(r.overall).toBe("MISMATCH");
  });

  it("flags a status divergence (db stale) as MISMATCH", () => {
    const r = reconcile(
      chainSnapshot(),
      dbSnapshot({ payments: [{ ...dbSnapshot().payments[0], status: "PENDING" }] }),
    );
    const f = r.fields.find((x) => x.field === "payment[1].status");
    expect(f?.verdict).toBe("MISMATCH");
    expect(f?.offchain).toBe("PENDING");
    expect(f?.onchain).toBe("EXECUTED");
  });

  it("marks a policy field UNAVAILABLE when the db does not cache policy (not a match)", () => {
    const r = reconcile(chainSnapshot(), dbSnapshot());
    const f = r.fields.find((x) => x.field === "policy.singleTxLimit");
    expect(f?.verdict).toBe("UNAVAILABLE");
    expect(f?.offchain).toBeNull();
    expect(f?.onchain).toBe("100000000");
  });

  it("marks a field UNAVAILABLE when only the on-chain side is missing (tx hash)", () => {
    const r = reconcile(chainSnapshot(), dbSnapshot());
    const f = r.fields.find((x) => x.field === "payment[1].createdTxHash");
    // db has a hash, chain has none (not stored on-chain) -> UNAVAILABLE, not a match.
    expect(f?.verdict).toBe("UNAVAILABLE");
  });

  it("flags a payment present on-chain but missing from the db", () => {
    const r = reconcile(chainSnapshot(), dbSnapshot({ payments: [] }));
    const f = r.fields.find((x) => x.field === "payment[1]");
    expect(f?.verdict).toBe("UNAVAILABLE");
    expect(f?.note).toMatch(/missing from the database/i);
  });

  it("flags a db row with no on-chain counterpart", () => {
    const r = reconcile(
      chainSnapshot({ payments: [], paymentCount: 0n }),
      dbSnapshot(),
    );
    const f = r.fields.find((x) => x.field === "payment[1]");
    expect(f?.verdict).toBe("UNAVAILABLE");
    expect(f?.note).toMatch(/not found on-chain/i);
  });

  it("compares treasury.paused as MATCH when both agree", () => {
    const r = reconcile(chainSnapshot(), dbSnapshot());
    const f = r.fields.find((x) => x.field === "treasury.paused");
    expect(f?.verdict).toBe("MATCH");
  });

  it("flags paused divergence", () => {
    const chain = chainSnapshot();
    chain.counters.paused = true;
    const r = reconcile(chain, dbSnapshot());
    const f = r.fields.find((x) => x.field === "treasury.paused");
    expect(f?.verdict).toBe("MISMATCH");
  });
});

describe("cmp", () => {
  it("classifies equal values as MATCH", () => {
    expect(cmp("f", "1", "1").verdict).toBe("MATCH");
  });
  it("classifies different values as MISMATCH", () => {
    expect(cmp("f", "1", "2").verdict).toBe("MISMATCH");
  });
  it("classifies one-sided as UNAVAILABLE", () => {
    expect(cmp("f", "1", null).verdict).toBe("UNAVAILABLE");
    expect(cmp("f", null, "1").verdict).toBe("UNAVAILABLE");
  });
  it("classifies neither side as UNAVAILABLE", () => {
    expect(cmp("f", null, null).verdict).toBe("UNAVAILABLE");
  });
});

describe("summarise", () => {
  it("counts each verdict", () => {
    const s = summarise([cmp("a", "1", "1"), cmp("b", "1", "2"), cmp("c", null, null)]);
    expect(s).toEqual({ match: 1, mismatch: 1, unavailable: 1 });
  });
});
