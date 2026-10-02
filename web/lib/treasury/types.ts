/**
 * Milestone J — treasury view models.
 *
 * These are the shapes the pages render. They are deliberately dumb: every monetary and status
 * value has already been decided by the chain or by the deterministic engine before it gets
 * here, and this file records only where it came from so a reader of the UI can tell.
 *
 * Each type carries a `source` marker on the facts that matter. That is the mechanism that keeps
 * the trust order visible in the interface rather than only in comments: a value tagged
 * "chain" cannot be quietly sourced from the database, and a value tagged "index" is visibly a
 * cache. No view model ever contains a field whose origin is ambiguous.
 *
 * STRING, NOT BIGINT: these types cross into JSX, and a BigInt in a rendered tree is a crash
 * waiting to happen. Everything is a decimal string, produced by `toJsonSafe` or by an explicit
 * `.toString()`, and parsed back with `BigInt` only where arithmetic is needed.
 */
import type {
  InvestigationErrorCode,
  InvestigationResult,
  InvestigationStatus,
} from "@/lib/investigation/types";
import type { InvestigatorResult } from "@/lib/investigator/types";
import type { StatusDisplay } from "@/lib/ui/status";

/** Where a displayed fact came from. Rendered in the UI so provenance is never implicit. */
/**
 * Where a displayed fact came from.
 *
 * `unavailable` is a first-class value rather than an omission: when a best-effort index read
 * fails, the field is still rendered but labelled as not obtained, which is the honest outcome
 * and not the same as `chain`.
 */
export type FactSource = "chain" | "index" | "engine" | "unavailable";

/** Display metadata from the database index. Presentation only, never authority. */
export type NetworkInfo = {
  chainId: number;
  name: string;
  nativeSymbol: string;
  explorerBaseUrl: string;
};

export type AssetInfo = {
  address: string;
  symbol: string;
  name: string;
  /** Read from the chain (`ChainSnapshot.assetDecimals`). Mirrored in the index for display. */
  decimals: number;
};

/**
 * Treasury identity and run state.
 *
 * Provenance is per-field, not per-object. `paused` is read from the contract and is authority;
 * owner and agent are configuration displayed from the index and are not treated as authority
 * anywhere. A single `source` field would force one of those two truths to be mislabelled, so the
 * sources are spelled out instead.
 */
export type TreasuryIdentity = {
  address: string;
  ownerAddress: string;
  agentAddress: string;
  paused: boolean;
  sources: {
    address: FactSource;
    paused: FactSource;
    ownerAddress: FactSource;
    agentAddress: FactSource;
  };
};

/**
 * One policy limit as displayed.
 *
 * `zeroMeans` exists because Treasury.sol uses 0 for two different things. For `singleTxLimit`,
 * `dailyLimit` and `monthlyLimit`, 0 removes the bound (UNLIMITED). For `autoApproveLimit`, 0 turns
 * auto-approval OFF. Collapsing the two would let the UI render "unlimited" above a threshold that
 * in fact refuses everything, so the semantics travel with the value and are never re-derived.
 */
export type PolicyLimitView = {
  id: string;
  label: string;
  /** Decimal string. */
  limit: string;
  zeroMeans: "UNLIMITED" | "DISABLED";
  /** `true` only when 0 genuinely means "no ceiling". Never true for `autoApproveLimit`. */
  unlimited: boolean;
  /** `true` when the mechanism is switched off, which only `autoApproveLimit` can be. */
  disabled: boolean;
};

/** Committed usage for the current bucket. `committed` is reserved + spent, per the contract. */
export type UsageView = {
  /** "day" | "month" */
  bucket: "day" | "month";
  /** Decimal string of committed (reserved + already settled) base units. */
  committed: string;
  limit: string;
  unlimited: boolean;
  /** Decimal string of remaining headroom as the CONTRACT computed it, or null when unlimited. */
  remaining: string | null;
  /** 0-100 integer for the meter width. Null when unlimited so no bar is drawn. */
  usedPercent: number | null;
  tone: "unlimited" | "ok" | "warning" | "exceeded";
  /** Rendered bucket identity, e.g. "2026-10" for a monthKey. */
  bucketLabel: string;
};

export type TreasuryOverview = {
  network: NetworkInfo;
  asset: AssetInfo;
  treasury: TreasuryIdentity;
  /** Decimal string; read from the token contract at the treasury address. */
  balance: string;
  policy: {
    singleTxLimit: PolicyLimitView;
    dailyLimit: PolicyLimitView;
    monthlyLimit: PolicyLimitView;
    autoApproveLimit: PolicyLimitView;
    allowUnknownRecipients: boolean;
  };
  usage: UsageView[];
  counters: {
    lifetimeReserved: string;
    lifetimeSpent: string;
    paymentCount: number;
  };
  /** The contract's own unbounded-auto-approval warning, passed through verbatim. */
  unboundedAutoApproval: boolean;
  /** Block the whole overview was observed at. One number, so the panel is internally consistent. */
  observedAtBlock: string;
  observedAtTimestamp: string;
};

/** One row in the payments table. Chain facts and index facts never share a field. */
export type PaymentRow = {
  paymentId: string;
  /** Authoritative status from the chain. */
  lifecycle: StatusDisplay;
  /** Raw numeric chain status, for tests and for tooltips. */
  lifecycleRaw: number;
  recipient: string;
  recipientApproved: boolean | null;
  recipientCategory: string;
  amountBaseUnits: string;
  /** Decoded bytes32 category from the chain, e.g. "MILESTONE-E". */
  category: string;
  /** Decoded bytes32 payment reference from the chain. */
  reference: string;
  dayIndex: string;
  monthKey: string;
  monthLabel: string;
  approvedBy: string | null;
  /** Transaction hashes come from the index only; they are not stored on chain. */
  createdTxHash: string | null;
  executedTxHash: string | null;
  approvedTxHash: string | null;
  createdBlockNumber: string | null;
  executedBlockNumber: string | null;
  createdAt: string | null;
  executedAt: string | null;
  /** False when the payment exists on chain but has no indexed row, so the UI can say so. */
  indexed: boolean;
};

export type PaymentList = {
  rows: PaymentRow[];
  explorerBaseUrl: string;
  asset: AssetInfo;
};

/**
 * The verdict panel.
 *
 * `policy` and `lifecycle` are separate fields on purpose and are never combined anywhere in
 * this file. The two can and do disagree (payment 2), and that divergence is shown to the user
 * rather than resolved.
 */
export type VerdictPanelModel = {
  policy: StatusDisplay;
  policyReasonCode: number;
  policyReasonName: string;
  policyAuthorityNote: string;
  /** Every failed check with its own reason and the two numbers compared. */
  reasons: InvestigationResult["policy"]["reasons"];
  /** Present only when the chain holds a payment at this id. */
  lifecycle: StatusDisplay | null;
  lifecycleRaw: string;
};

/** One failed policy check, projected from the deterministic investigation result. */
export type EvidenceCheckRow = {
  code: number;
  reasonName: string;
  checkId: string | null;
  label: string | null;
  limit: string | null;
  actual: string | null;
};

export type EvidencePanelModel = {
  hash: string;
  version: string;
  chainId: number;
  treasuryAddress: string;
  observedAtBlockNumber: string;
  observedAtBlockTimestamp: string;
  /**
   * Every check that FAILED, with its own reason code and the two numbers the contract compared.
   *
   * Deliberately only the failures. Milestone I exposes the verdict's failing checks rather than
   * the full PASS/FAIL/SKIPPED list, and this panel reports exactly what the investigation
   * produced. A UI that re-ran the policy checks to fill in the passing ones would be a second
   * policy engine — exactly the duplication this milestone forbids.
   */
  checks: EvidenceCheckRow[];
  /** Per-field provenance, copied from the investigation's own `context.sources`. */
  sources: Record<string, string>;
  /** Whether the off-chain mirror agreed with the contract's own `evaluatePayment`. */
  mirrorAgreesWithContract: boolean;
  /** Whether the chain holds a payment at this id at all. */
  paymentPresentOnChain: boolean;
};

/** The advisory section. Always rendered with a permanent advisory-only notice. */
export type InvestigatorPanelModel = {
  status: StatusDisplay;
  summary: string;
  recommendation: InvestigatorResult["recommendation"];
  recommendationLabel: string;
  authority: "ADVISORY_ONLY";
  findings: { type: string; statement: string; evidenceKeys: string[] }[];
  uncertainties: string[];
  diagnostics: {
    provider: string;
    model: string;
    promptVersion: string;
    latencyMs: number | null;
    validation: string;
    ungroundedCitationCount: number | null;
    recommendationConstrained: boolean;
  } | null;
  /** True when the investigator was never called because a gate failed. */
  gated: boolean;
  gates: { code: string; detail: string; fields?: string[] }[];
};

export type ReconciliationPanelModel = {
  overall: StatusDisplay;
  /**
   * One readable line, built from G's own counts. See `reconciliationSummary` in `detail.ts` for
   * why only matching fields are described as "checked".
   */
  summary: string;
  fields: {
    field: string;
    verdict: StatusDisplay;
    offchain: string | null;
    onchain: string | null;
    note?: string;
  }[];
  onchainBlockNumber: string;
};

export type DetailPanelModel = {
  status: InvestigationStatus;
  paymentId: string;
  reference: string;
  verdict: VerdictPanelModel;
  evidence: EvidencePanelModel;
  investigator: InvestigatorPanelModel;
  reconciliation: ReconciliationPanelModel;
  settlement: {
    lifecycle: StatusDisplay | null;
    createdTxHash: string | null;
    approvedTxHash: string | null;
    executedTxHash: string | null;
    createdBlockNumber: string | null;
    approvedBlockNumber: string | null;
    executedBlockNumber: string | null;
    createdAt: string | null;
    executedAt: string | null;
    approvedBy: string | null;
    executedBy: string | null;
    requestedBy: string | null;
  };
  network: NetworkInfo;
  asset: AssetInfo;
  explorerBaseUrl: string;
};

/** The investigation outcome as a page can render it, including the refusal cases. */
export type DetailPageModel =
  | { kind: "ok"; detail: DetailPanelModel }
  | {
      kind: "error";
      /**
       * The investigation's own code, kept as the narrow union rather than `string` so a page
       * cannot render a refusal tone that was not chosen deliberately: an unrecognised code should
       * fail to typecheck, not quietly fall through to a default colour.
       */
      code: InvestigationErrorCode;
      title: string;
      explanation: string;
      /** Present on 422s, where the deterministic verdict and reconciliation ARE the answer. */
      partial: DetailPanelModel | null;
    };