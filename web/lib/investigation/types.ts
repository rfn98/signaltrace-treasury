/**
 * Milestone I — investigation types and the boundary between the layers.
 *
 * THE ORDER OF TRUST, restated because every type below depends on it:
 *
 *   1. The chain is authoritative. Amount, recipient, status, policy limits, balances,
 *      allowlist state and counters are read from Arbitrum Sepolia, never from the database.
 *   2. The database is an index/cache of chain history. It contributes payment identity and
 *      provenance only, and where it disagrees with the chain it is reported, not believed.
 *   3. The deterministic G policy engine produces the verdict.
 *   4. The H investigator explains that verdict and can never change it.
 *
 * So `policy` in `InvestigationResult` is computed from chain state by G, and `investigator`
 * is the only field here that any model has ever touched.
 */
import type { InvestigatorResult, InvestigatorStatus, PolicyDecision } from "@/lib/investigator/types";
import type { ReconciliationReport } from "@/lib/reconcile/types";
import type { DbSnapshot } from "@/lib/reconcile/compare";
import type { ChainSnapshot } from "@/lib/chain/adapter";
import type { RecipientState, Payment } from "@/lib/policy/types";
import type { Evidence } from "@/lib/evidence/build";

/** Bumped when the shape below changes. Evidence keeps its own independent version. */
export const INVESTIGATION_VERSION = "signaltrace.investigation/v1";

/**
 * Whether the investigation reached a conclusion the caller may rely on.
 *
 * `COMPLETE` means: the evidence was internally consistent, the DB agreed with the chain on
 * everything the verdict depends on, the off-chain mirror agreed with the contract itself, and
 * the advisory layer returned whatever it returned. `INSUFFICIENT_EVIDENCE` means one of those
 * preconditions failed and the AI was deliberately NOT called — see `gating`.
 */
export type InvestigationStatus = "COMPLETE" | "INSUFFICIENT_EVIDENCE";

/**
 * Machine-readable failure reasons. These are stable codes, not prose, so a client can branch
 * on them without pattern-matching a message.
 */
export type InvestigationErrorCode =
  /** The `:paymentId` segment is not a decimal payment id. Rejected before any I/O. */
  | "INVALID_PAYMENT_ID"
  /** No such payment in the database index. */
  | "PAYMENT_NOT_FOUND"
  /** Database or RPC unreachable. The verdict could not be established at all. */
  | "DEPENDENCY_UNAVAILABLE"
  /** Chain and database disagree on something the verdict depends on. */
  | "EVIDENCE_INCONSISTENT"
  /** The payment exists in the index but is not visible on-chain, or evidence is unusable. */
  | "EVIDENCE_INSUFFICIENT";

/** HTTP status per error code. 422 = "the state you asked about is not verifiable as-is". */
export const HTTP_STATUS_BY_CODE: Record<InvestigationErrorCode, number> = {
  INVALID_PAYMENT_ID: 400,
  PAYMENT_NOT_FOUND: 404,
  DEPENDENCY_UNAVAILABLE: 503,
  EVIDENCE_INCONSISTENT: 422,
  EVIDENCE_INSUFFICIENT: 422,
};

/**
 * One failing policy check, projected out of the G evidence record.
 *
 * This is a VIEW of evidence that already exists — the check, its reason code, and the two
 * numbers the contract compared. Nothing is recomputed here.
 */
export type InvestigationReason = {
  /** Solidity ReasonCode, mirroring `PolicyDecision` reasoning. */
  code: number;
  name: string;
  checkId: string | null;
  label: string | null;
  limitBaseUnits: string | null;
  actualBaseUnits: string | null;
};

/** The authoritative verdict. Produced by the deterministic G engine from chain state. */
export type InvestigationPolicyView = {
  decision: PolicyDecision;
  allowed: boolean;
  /** Primary reason code the contract reports for this decision (0 = None). */
  reasonCode: number;
  reasonName: string;
  /** Every check that failed, with its own reason. Empty when the decision is AUTO_APPROVED. */
  reasons: InvestigationReason[];
  /** Reused verbatim from G evidence so the authority boundary is not restated in prose. */
  authorityNote: string;
};

/** Identity and integrity of the evidence the verdict rests on. */
export type InvestigationEvidenceView = {
  hash: string;
  version: Evidence["schemaVersion"];
  chainId: number;
  treasuryAddress: string;
  observedAtBlockNumber: string;
  observedAtBlockTimestamp: string;
};

/**
 * The advisory layer. `status` is widened by exactly one value over Milestone H:
 * `INSUFFICIENT_EVIDENCE` means "the AI was intentionally not called", which is a statement
 * about this orchestration layer and not something a provider can report.
 */
export type InvestigatorView = Omit<InvestigatorResult, "status"> & {
  status: InvestigatorStatus | "INSUFFICIENT_EVIDENCE";
};

/**
 * Why the investigation did or did not reach a conclusion.
 *
 * `gating` is empty for `COMPLETE`. When it is not empty, `investigator.status` is
 * `INSUFFICIENT_EVIDENCE` and the provider was never invoked — recorded here so a caller can
 * tell "the model had nothing to add" apart from "we refused to ask".
 */
export type InvestigationGate = {
  code: string;
  detail: string;
  /** Reconciliation field paths that disagreed, when the gate is a reconciliation mismatch. */
  fields?: string[];
};

export type InvestigationContext = {
  /** Where each input came from. Stated per-field because the trust order is the whole point. */
  sources: {
    paymentAmount: "chain";
    recipient: "chain";
    recipientApproval: "chain";
    policy: "chain";
    balances: "chain";
    counters: "chain";
    paymentStatus: "chain";
    paymentIdentity: "database-index";
  };
  /** The payment's authoritative status as read on-chain, as a G enum name. */
  onChainStatus: string;
  /** Whether the off-chain mirror agreed with the contract's own `evaluatePayment`. */
  mirrorAgreesWithContract: boolean;
  /** True when a payment is absent from the chain snapshot at or below the requested id. */
  paymentPresentOnChain: boolean;
};

/**
 * The Milestone I result.
 *
 * `policy` and `evidence` are deterministic. `investigator` is advisory and cannot have
 * contributed to `policy`. `reconciliation` is included because a verdict that silently
 * ignored a stale cache row would be worse than no verdict at all.
 */
export type InvestigationResult = {
  investigationVersion: string;
  request: {
    /** The on-chain payment id, normalised from the request. */
    paymentId: string;
    /** Payment reference (bytes32) as recorded on-chain. */
    reference: string;
  };
  policy: InvestigationPolicyView;
  evidence: InvestigationEvidenceView;
  investigator: InvestigatorView;
  reconciliation: ReconciliationReport;
  context: InvestigationContext;
  gating: InvestigationGate[];
};

/**
 * Discriminated outcome. `ok: false` carries a stable code the route maps to a status, and may
 * still carry a partial `result` — a policy-affecting inconsistency yields the deterministic
 * policy view and the reconciliation report that caused it, so the caller is not left blind.
 */
export type InvestigationOutcome =
  | { ok: true; result: InvestigationResult }
  | {
      ok: false;
      error: { code: InvestigationErrorCode; message: string };
      result: InvestigationResult | null;
    };

/**
 * The database row for a payment, as identity/provenance only.
 *
 * Monetary and status fields are present because Milestone G reconciliation compares them
 * against the chain. They are NOT used to compute the verdict.
 */
export type PaymentRecord = {
  /** Milestone F identity: the on-chain payment id this row indexes. */
  onChainPaymentId: bigint;
  /** Milestone F identity: the database row's own surrogate id. */
  dbRowId: number;
  reference: string;
  category: string;
  amountBaseUnits: bigint;
  recipientAddress: string;
  /** Prisma enum name, as Milestone G reconciliation expects it. */
  status: string;
  dayIndex: number;
  monthKey: number;
  createdTxHash: string | null;
  createdBlockNumber: bigint | null;
  executedTxHash: string | null;
  executedBlockNumber: bigint | null;
  treasuryAddress: string;
};

/**
 * Read-only persistence boundary.
 *
 * Two methods, both pure reads. The AI never sees this interface — it is handed a serialized
 * evidence string and nothing else — which is enforced by an architecture test.
 */
export interface PaymentRepository {
  findPayment(onChainPaymentId: bigint): Promise<PaymentRecord | null>;
  /** The Milestone G comparison input for one treasury, or null when the row is gone. */
  loadDbSnapshot(treasuryAddress: string): Promise<DbSnapshot | null>;
}

/** Everything read from the chain for one investigation, at a single observed block. */
export type ChainContext = {
  snapshot: ChainSnapshot;
  committed: { dayKey: bigint; monthKey: bigint; dayCommitted: bigint; monthCommitted: bigint };
  /** The investigated payment as the chain holds it, or null when the chain has no such id. */
  payment: Payment | null;
  /** Allowlist state for that payment's recipient, read directly from the contract. */
  recipient: RecipientState;
  /** The contract's own verdict for this (recipient, amount), via Milestone G. */
  contractVerdict: { allowed: boolean; reason: number } | null;
};

/** Read-only chain boundary, so tests can supply observed state without an RPC endpoint. */
export interface ChainStateReader {
  read(input: { treasuryAddress: string; onChainPaymentId: bigint }): Promise<ChainContext>;
}

/**
 * Normalises a `:paymentId` path segment.
 *
 * Deliberately strict, and checked BEFORE any database, RPC or AI call: a payment id is a
 * decimal integer, so anything else is malformed input rather than a payment to go looking for.
 * Leading zeros are rejected because "007" and "7" would otherwise be two spellings of one id
 * and both would be cached under different keys. The length cap keeps the value inside uint256
 * range so `BigInt()` can never be handed something absurd.
 */
export function parsePaymentId(raw: string | undefined): bigint | null {
  if (typeof raw !== "string") return null;
  if (!/^[1-9][0-9]{0,77}$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}