/**
 * Milestone I test fixtures.
 *
 * Built from `prisma/seed-data.ts` and `lib/policy/types.ts` — the real Milestone E deployment
 * values — so these tests exercise the same amounts, limits and addresses the chain actually
 * holds. No invented policy numbers: if the deployed limits change, the expected outcomes here
 * change with them, which is the point.
 *
 * Every fixture is deterministic. No `Date.now()`, no randomness, no RPC: the investigation
 * service takes observed chain state as an input precisely so that a test can state what the
 * chain said and then assert what the system concluded.
 */
import type { DbSnapshot, DbPayment } from "@/lib/reconcile/compare";
import {
  CHAIN_ID,
  MIL_E_POLICY,
  PaymentStatus,
  RECIPIENT_MILESTONE_E,
  TREASURY_ADDRESS,
  type Policy,
} from "@/lib/policy/types";
import type { InvestigatorInput, InvestigatorProvider, InvestigatorResult } from "@/lib/investigator/types";
import type {
  ChainContext,
  ChainStateReader,
  PaymentRecord,
  PaymentRepository,
} from "../types";

/** Encodes a label the way the contract stores `category`/`paymentRef`: right-padded bytes32. */
export function bytes32Of(label: string): string {
  const hex = Buffer.from(label, "utf8").toString("hex").padEnd(64, "0");
  return `0x${hex}`;
}

export const PAYMENT_ONE_AMOUNT = 10_000_000n;
export const PAYMENT_TWO_AMOUNT = 50_000_000n;
export const BLOCKING_AMOUNT = 900_000_000n;

export const PAYMENT_ONE_REF = bytes32Of("MILESTONE-E-PAYMENT-1");
export const PAYMENT_TWO_REF = bytes32Of("MILESTONE-E-PAYMENT-2");

/** Day/month the fixture pretends to observe. Fixed so evidence hashes are reproducible. */
export const DAY_KEY = 20727n;
export const MONTH_KEY = 24322n;
export const BLOCK_NUMBER = 314_303_200n;
export const BLOCK_TIMESTAMP = 1_790_774_000n;

/**
 * Amount that breaches `monthlyLimit` (2_000_000_000) and `singleTxLimit` (100_000_000).
 * Chosen to be unambiguously over every limit, so the BLOCKED assertion cannot pass by accident.
 */
export type Scenario = {
  name: string;
  paymentId: bigint;
  /** Amount as the chain holds it. */
  amount: bigint;
  balance: bigint;
  dayCommitted: bigint;
  monthCommitted: bigint;
  expectedDecision: "AUTO_APPROVED" | "PENDING" | "BLOCKED";
};

/**
 * The three policy outcomes the acceptance criteria name, on real Milestone E inputs.
 *
 * All three vary the amount of payment 1, which is the payment under test; payment 2 keeps its
 * seeded amount so the index and the chain stay in agreement for it as well.
 */
export const SCENARIOS: Scenario[] = [
  {
    name: "AUTO_APPROVED: 10 mUSD is within the 25 mUSD auto-approval limit",
    paymentId: 1n,
    amount: PAYMENT_ONE_AMOUNT,
    balance: 140_000_000n,
    dayCommitted: 0n,
    monthCommitted: 0n,
    expectedDecision: "AUTO_APPROVED",
  },
  {
    name: "PENDING: 50 mUSD is allowed but above the auto-approval limit",
    paymentId: 1n,
    amount: PAYMENT_TWO_AMOUNT,
    balance: 140_000_000n,
    dayCommitted: 0n,
    monthCommitted: 0n,
    expectedDecision: "PENDING",
  },
  {
    name: "BLOCKED: 900 mUSD breaches the single-transaction limit",
    paymentId: 1n,
    amount: BLOCKING_AMOUNT,
    balance: 140_000_000n,
    dayCommitted: 0n,
    monthCommitted: 0n,
    expectedDecision: "BLOCKED",
  },
];

export function chainPayment(
  id: bigint,
  amount: bigint,
  status: PaymentStatus = PaymentStatus.Executed,
) {
  return {
    id,
    recipient: RECIPIENT_MILESTONE_E,
    amount,
    status,
    dayIndex: 20726n,
    monthKey: 24321n,
    approvedBy: null,
    category: bytes32Of("MILESTONE-E"),
    paymentRef: id === 1n ? PAYMENT_ONE_REF.slice(2) : PAYMENT_TWO_REF.slice(2),
  };
}

export type FixtureOverrides = {
  /** Amount of the payment under test (the first id in `chainPaymentIds`). */
  amount?: bigint;
  balance?: bigint;
  policy?: Policy;
  dayCommitted?: bigint;
  monthCommitted?: bigint;
  /** Payment ids the chain exposes. Omit one to model an index row the chain does not have. */
  chainPaymentIds?: bigint[];
  approved?: boolean;
};

/** The amount the real Milestone E deployment recorded for each payment. */
function seededAmount(id: bigint): bigint {
  return id === 2n ? PAYMENT_TWO_AMOUNT : PAYMENT_ONE_AMOUNT;
}

/**
 * Builds the observed chain state the service is handed.
 *
 * `amount` overrides only the payment under test — the first id in `chainPaymentIds`. The other
 * payments keep their seeded amounts, because a fixture that rewrote every payment would make
 * the index row for payment 2 disagree with the chain and gate the investigation before any
 * assertion about payment 1 could run.
 */
export function makeChainContext(overrides: FixtureOverrides = {}): ChainContext {
  const ids = overrides.chainPaymentIds ?? [1n, 2n];
  const primaryId = ids[0];
  const payments = ids.map((id) =>
    chainPayment(id, id === primaryId ? (overrides.amount ?? seededAmount(id)) : seededAmount(id)),
  );

  return {
    snapshot: {
      chainId: CHAIN_ID,
      blockNumber: BLOCK_NUMBER,
      blockTimestamp: BLOCK_TIMESTAMP,
      treasuryAddress: TREASURY_ADDRESS,
      assetAddress: "0xe8B0C9500D8BD0FF5528E80Ae986F2EF2B224233",
      assetDecimals: 6,
      policy: overrides.policy ?? MIL_E_POLICY,
      counters: {
        reservedDay: {},
        reservedMonth: {},
        spentDay: {},
        spentMonth: {},
        lifetimeReserved: 60_000_000n,
        lifetimeSpent: 60_000_000n,
        balance: overrides.balance ?? 140_000_000n,
        paused: false,
      },
      paymentCount: BigInt(ids.length),
      payments,
    },
    committed: {
      dayKey: DAY_KEY,
      monthKey: MONTH_KEY,
      dayCommitted: overrides.dayCommitted ?? 0n,
      monthCommitted: overrides.monthCommitted ?? 0n,
    },
    payment: payments[0] ?? null,
    recipient: { approved: overrides.approved ?? true, category: bytes32Of("MILESTONE-E") },
    contractVerdict: null,
  };
}

/**
 * Fills in the contract verdict the way Treasury.sol would, so tests do not have to hardcode a
 * second expected answer. Computed from the same fixture policy the evidence builder sees, which
 * is what makes a mirror divergence expressible as a deliberate override below.
 */
function contractVerdictFor(policy: Policy, amount: bigint, balance: bigint, committedDay: bigint, committedMonth: bigint, approved: boolean, paused: boolean): { allowed: boolean; reason: number } {
  if (amount === 0n) return { allowed: false, reason: 2 };
  if (!approved) return { allowed: false, reason: 4 };
  if (paused) return { allowed: false, reason: 9 };
  if (policy.singleTxLimit !== 0n && amount > policy.singleTxLimit) return { allowed: false, reason: 5 };
  if (balance < amount) return { allowed: false, reason: 8 };
  if (policy.dailyLimit !== 0n && committedDay + amount > policy.dailyLimit) return { allowed: false, reason: 6 };
  if (policy.monthlyLimit !== 0n && committedMonth + amount > policy.monthlyLimit) return { allowed: false, reason: 7 };
  return { allowed: true, reason: 0 };
}

/** Context with the contract verdict filled in, matching the off-chain mirror by construction. */
export function makeAgreeingChain(overrides: FixtureOverrides = {}): ChainContext {
  const context = makeChainContext(overrides);
  const payment = context.payment;
  if (!payment) return { ...context, contractVerdict: null };
  return {
    ...context,
    contractVerdict: contractVerdictFor(
      context.snapshot.policy,
      payment.amount,
      context.snapshot.counters.balance,
      context.committed.dayCommitted,
      context.committed.monthCommitted,
      context.recipient.approved,
      context.snapshot.counters.paused,
    ),
  };
}

export function makePaymentRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    onChainPaymentId: 1n,
    dbRowId: 1,
    reference: `0x${PAYMENT_ONE_REF.slice(2)}`,
    category: "MILESTONE-E",
    amountBaseUnits: PAYMENT_ONE_AMOUNT,
    recipientAddress: RECIPIENT_MILESTONE_E,
    status: "EXECUTED",
    dayIndex: 20726,
    monthKey: 24321,
    createdTxHash: null,
    createdBlockNumber: null,
    executedTxHash: null,
    executedBlockNumber: null,
    treasuryAddress: TREASURY_ADDRESS,
    ...overrides,
  };
}

/** Database rows that agree with the chain fixture, so reconciliation reports no mismatch. */
export function makeDbSnapshot(
  payments: DbPayment[],
  overrides: Partial<DbSnapshot> = {},
): DbSnapshot {
  return {
    treasuryAddress: TREASURY_ADDRESS,
    ownerAddress: "0xfcdf7Cfa55d371675E65E9bdc7546F6B85B2730e",
    agentAddress: "0x523134AbaEd332378158F64EaA14AFBc446b4169",
    paused: false,
    recipients: [{ address: RECIPIENT_MILESTONE_E, approved: true, category: "MILESTONE-E" }],
    payments,
    ...overrides,
  };
}

/**
 * Both Milestone E payments are settled on-chain, so the index rows say EXECUTED. Keeping the
 * two sides in agreement matters: the service refuses to investigate a policy-affecting
 * mismatch, so a fixture that disagreed with itself would fail before reaching any assertion.
 */
export function dbPaymentFor(id: bigint, amount: bigint, status: DbPayment["status"] = "EXECUTED"): DbPayment {
  return {
    onChainPaymentId: id,
    amountBaseUnits: amount,
    status,
    dayIndex: 20726,
    monthKey: 24321,
    reference: `0x${(id === 1n ? PAYMENT_ONE_REF : PAYMENT_TWO_REF).slice(2)}`,
    recipientAddress: RECIPIENT_MILESTONE_E,
    createdTxHash: null,
    createdBlockNumber: null,
    executedTxHash: null,
    executedBlockNumber: null,
  };
}

/**
 * Derives an index snapshot that agrees with the chain fixture.
 *
 * The database is a cache of chain history, so "agreeing" is its natural state and a
 * disagreement has to be constructed deliberately. Building it from the chain fixture is what
 * keeps the two from drifting apart while a test varies one of them.
 */
export function dbSnapshotFromChain(context: ChainContext): DbSnapshot {
  return makeDbSnapshot(
    context.snapshot.payments.map((p) => ({
      onChainPaymentId: p.id,
      amountBaseUnits: p.amount,
      status: (p.status === PaymentStatus.AutoApproved ? "AUTO_APPROVED" : "EXECUTED") as DbPayment["status"],
      dayIndex: Number(p.dayIndex),
      monthKey: Number(p.monthKey),
      reference: `0x${(p.paymentRef ?? "").replace(/^0x/, "")}`,
      recipientAddress: p.recipient,
      createdTxHash: null,
      createdBlockNumber: null,
      executedTxHash: null,
      executedBlockNumber: null,
    })),
  );
}

/** The index row for one payment, derived from the chain fixture. */
export function recordFromChain(context: ChainContext, paymentId: bigint): PaymentRecord {
  const payment = context.snapshot.payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`recordFromChain: chain has no payment ${paymentId}`);
  return makePaymentRecord({
    onChainPaymentId: payment.id,
    dbRowId: Number(payment.id),
    reference: `0x${(payment.paymentRef ?? "").replace(/^0x/, "")}`,
    amountBaseUnits: payment.amount,
    recipientAddress: payment.recipient,
    status: (payment.status === PaymentStatus.AutoApproved ? "AUTO_APPROVED" : "EXECUTED") as string,
    dayIndex: Number(payment.dayIndex),
    monthKey: Number(payment.monthKey),
  });
}

/** A repository whose index agrees with `context`, so nothing is gated on a mismatch. */
export function agreeingRepository(context: ChainContext, paymentId = 1n): StubRepository {
  return new StubRepository([recordFromChain(context, paymentId)], dbSnapshotFromChain(context));
}

/** In-memory repository over a fixed record set. Read-only, like the real one. */
export class StubRepository implements PaymentRepository {
  constructor(
    private readonly records: PaymentRecord[],
    private readonly snapshot: DbSnapshot | null,
  ) {}

  async findPayment(onChainPaymentId: bigint): Promise<PaymentRecord | null> {
    return this.records.find((r) => r.onChainPaymentId === onChainPaymentId) ?? null;
  }

  async loadDbSnapshot(): Promise<DbSnapshot | null> {
    return this.snapshot;
  }
}

/** Repository whose every read rejects, to exercise the dependency-unavailable path. */
export class FailingRepository implements PaymentRepository {
  async findPayment(): Promise<PaymentRecord | null> {
    throw new Error("database unreachable");
  }
  async loadDbSnapshot(): Promise<DbSnapshot | null> {
    throw new Error("database unreachable");
  }
}

/** Chain reader returning fixed observed state, counting how often it was asked. */
export class StubChainReader implements ChainStateReader {
  calls = 0;
  constructor(private readonly context: ChainContext) {}
  async read(input: { treasuryAddress: string; onChainPaymentId: bigint }): Promise<ChainContext> {
    this.calls++;
    // Mirror the real reader: return the payment matching the requested id.
    const requested = this.context.snapshot.payments.find((p) => p.id === input.onChainPaymentId) ?? null;
    return { ...this.context, payment: requested };
  }
}

/** Chain reader that rejects, to exercise the dependency-unavailable path. */
export class FailingChainReader implements ChainStateReader {
  async read(): Promise<ChainContext> {
    throw new Error("rpc unreachable");
  }
}

/** Provider that records every input it is handed, so a test can assert what reached the model. */
export class RecordingProvider implements InvestigatorProvider {
  readonly name = "recording";
  inputs: InvestigatorInput[] = [];

  constructor(private readonly result: InvestigatorResult) {}

  async investigate(input: InvestigatorInput): Promise<InvestigatorResult> {
    this.inputs.push(input);
    return this.result;
  }

  get callCount(): number {
    return this.inputs.length;
  }
}

/** A well-formed advisory result for the given decision. */
export function okInvestigator(decision: "AUTO_APPROVED" | "PENDING" | "BLOCKED"): InvestigatorResult {
  return {
    status: "OK",
    summary: "The request is within the observed policy limits.",
    recommendation: decision === "BLOCKED" ? "BLOCK" : "PROCEED_TO_HUMAN_REVIEW",
    findings: [
      {
        type: decision === "BLOCKED" ? "POLICY_FAIL" : "POLICY_PASS",
        statement: "Amount checked against the observed single-transaction limit.",
        evidenceKeys: ["request.amountBaseUnits", "policy.singleTxLimit"],
      },
    ],
    uncertainties: [],
    authority: "ADVISORY_ONLY",
  };
}