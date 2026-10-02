/**
 * Milestone J — investigation detail view model.
 *
 * DELIBERATELY PURE: no `server-only`, no Prisma, no viem, no env. It takes an
 * `InvestigationOutcome` plus the indexed provenance a page already fetched and returns something
 * renderable. That is what makes the rules in this file testable without a database or an RPC
 * endpoint, and the rules are the whole point.
 *
 * THE TWO LAWS ENFORCED HERE:
 *
 *  1. POLICY DECISION IS NEVER DERIVED FROM LIFECYCLE STATUS, AND NEVER THE REVERSE.
 *     `verdict.policy` comes from Milestone G's `policy.decision` and `verdict.lifecycle` comes
 *     from `context.onChainStatus`. They are read from two different fields, put in two different
 *     slots, and no branch in this file ever fills one from the other. Payment 2 renders as
 *     Policy: Pending alongside On-chain: Executed, which is the truth and also the best evidence
 *     the product has that the human-in-the-loop step works.
 *
 *  2. THE ADVISORY LAYER NEVER SUPPLIES A DECISION.
 *     Its text lands in `investigator.*` only. There is no field in `VerdictPanelModel` that an
 *     investigator value can reach, and `investigator.authority` is carried through as the
 *     literal `"ADVISORY_ONLY"` type rather than being asserted in prose.
 */
import type { InvestigationOutcome, InvestigationResult } from "@/lib/investigation/types";
import type { InvestigatorRecommendation } from "@/lib/investigator/types";
import type { ReconciliationReport } from "@/lib/reconcile/types";
import {
  investigatorStatus,
  lifecycleStatus,
  policyStatus,
  reconciliationStatus,
} from "@/lib/ui/status";
import type {
  DetailPageModel,
  DetailPanelModel,
  EvidencePanelModel,
  InvestigatorPanelModel,
  NetworkInfo,
  AssetInfo,
  ReconciliationPanelModel,
  VerdictPanelModel,
} from "./types";

/**
 * Indexed provenance for one payment, as `getPaymentRequests` returns it.
 *
 * Typed loosely on purpose: these are the ONLY fields the UI may take from the database, and
 * they are all identity/provenance. Anything monetary or status-like is absent by construction, so
 * a future edit cannot quietly widen the trust boundary here.
 */
export type IndexedProvenance = {
  requestedBy?: string | null;
  approvedBy?: string | null;
  executedBy?: string | null;
  createdTxHash?: string | null;
  approvedTxHash?: string | null;
  executedTxHash?: string | null;
  rejectedTxHash?: string | null;
  createdBlockNumber?: string | null;
  approvedBlockNumber?: string | null;
  executedBlockNumber?: string | null;
  createdAt?: string | null;
  executedTxAt?: string | null;
};

const RECOMMENDATION_LABEL: Record<InvestigatorRecommendation, string> = {
  // Phrased so the advisory layer cannot be read as holding authority. "suggested" and
  // "a human may" are the operative words; neither says a payment may proceed.
  PROCEED_TO_HUMAN_REVIEW: "Human review suggested",
  NO_ACTION: "No action suggested",
  BLOCK: "Concern raised for review",
  INSUFFICIENT_EVIDENCE: "Not enough evidence to comment",
};

function verdictModel(result: InvestigationResult): VerdictPanelModel {
  // Law 1: two independent reads. `policy.decision` and `context.onChainStatus` are not related,
  // and this function is where that separation is made structurally visible.
  const present = result.context.paymentPresentOnChain;

  return {
    policy: policyStatus(result.policy.decision),
    policyReasonCode: result.policy.reasonCode,
    policyReasonName: result.policy.reasonName,
    policyAuthorityNote: result.policy.authorityNote,
    reasons: result.policy.reasons,
    lifecycle: present ? lifecycleStatus(result.context.onChainStatus) : null,
    lifecycleRaw: result.context.onChainStatus,
  };
}

/**
 * Evidence panel, projected entirely out of the investigation result.
 *
 * No check is re-derived here. The result already carries every check that FAILED, with its own
 * reason code and the two numbers the contract compared, so those are copied verbatim. The passing
 * checks are not exposed by the investigation and are NOT reconstructed: doing so would mean
 * re-running policy evaluation inside the UI, which is a second policy engine and a second place
 * for the verdict to drift.
 */
function evidenceModel(result: InvestigationResult): EvidencePanelModel {
  return {
    hash: result.evidence.hash,
    version: result.evidence.version,
    chainId: result.evidence.chainId,
    treasuryAddress: result.evidence.treasuryAddress,
    observedAtBlockNumber: result.evidence.observedAtBlockNumber,
    observedAtBlockTimestamp: result.evidence.observedAtBlockTimestamp,
    checks: result.policy.reasons.map((r) => ({
      code: r.code,
      reasonName: r.name,
      checkId: r.checkId,
      label: r.label,
      limit: r.limitBaseUnits,
      actual: r.actualBaseUnits,
    })),
    // The investigation already states, per field, whether the chain or the index supplied it.
    // Surfacing that verbatim is the most honest possible provenance display, and it costs the UI
    // nothing to be correct about it.
    sources: { ...result.context.sources },
    mirrorAgreesWithContract: result.context.mirrorAgreesWithContract,
    paymentPresentOnChain: result.context.paymentPresentOnChain,
  };
}

function investigatorModel(result: InvestigationResult): InvestigatorPanelModel {
  const inv = result.investigator;
  // Derived from `gating`, not from `inv.status`. The service also sets the status to
  // INSUFFICIENT_EVIDENCE when it gates, but depending on that would make the UI's "was the
  // provider asked?" answer contingent on an internal invariant elsewhere. A non-empty gate list
  // is directly observable and means the same thing: the question was never put to a model.
  const gated = result.gating.length > 0;
  const d = inv.diagnostics;

  return {
    status: investigatorStatus(inv.status),
    summary: inv.summary,
    recommendation: inv.recommendation,
    recommendationLabel: RECOMMENDATION_LABEL[inv.recommendation] ?? "Not stated",
    // Carried as a literal type, so a value other than ADVISORY_ONLY would not typecheck.
    authority: "ADVISORY_ONLY",
    findings: inv.findings.map((f) => ({
      type: f.type,
      statement: f.statement,
      evidenceKeys: f.evidenceKeys,
    })),
    uncertainties: inv.uncertainties,
    diagnostics: d
      ? {
          provider: d.provider,
          model: d.model,
          promptVersion: d.promptVersion,
          latencyMs: d.latencyMs ?? null,
          validation: d.validation,
          ungroundedCitationCount: d.ungroundedCitationCount ?? null,
          recommendationConstrained: d.recommendationConstrained ?? false,
        }
      : null,
    gated,
    gates: result.gating,
  };
}

/**
 * One-line summary of the reconciliation, built from G's own counts.
 *
 * The word "checked" is load-bearing. Nineteen of the fields this project reconciles are
 * deliberately NOT cached off-chain, and those arrive as UNAVAILABLE rather than as matches. Saying
 * "19 checked, 0 mismatched" for fields nobody compared would turn a deliberate design decision
 * into a false assurance, so only `match` is described as checked.
 */
function reconciliationSummary(rec: ReconciliationReport["summary"]): string {
  const parts = [`${rec.match} checked and matching`];
  if (rec.mismatch > 0) parts.push(`${rec.mismatch} mismatched`);
  if (rec.unavailable > 0) parts.push(`${rec.unavailable} not compared (not stored off-chain)`);
  return `${parts.join(", ")}.`;
}

function reconciliationModel(result: InvestigationResult): ReconciliationPanelModel {
  const rec = result.reconciliation;
  return {
    overall: reconciliationStatus(rec.overall),
    summary: reconciliationSummary(rec.summary),
    onchainBlockNumber: rec.onchainBlockNumber,
    fields: rec.fields.map((f) => ({
      field: f.field,
      verdict: reconciliationStatus(f.verdict),
      offchain: f.offchain,
      onchain: f.onchain,
      note: f.note,
    })),
  };
}

/**
 * Error copy for the refusal cases.
 *
 * `EVIDENCE_INCONSISTENT` is worded carefully: a disagreement is a finding, not a failure of the
 * product. The UI shows the reconciliation table alongside it, because that table IS the answer.
 */
const ERROR_COPY: Record<string, { title: string; explanation: string }> = {
  INVALID_PAYMENT_ID: {
    title: "Not a payment id",
    explanation: "A payment id is a decimal integer. This value was rejected before any chain or database read.",
  },
  PAYMENT_NOT_FOUND: {
    title: "No such payment",
    explanation: "The database index holds no payment at this id. Nothing is claimed about the chain.",
  },
  DEPENDENCY_UNAVAILABLE: {
    title: "Chain or index unavailable",
    explanation:
      "Observed state could not be read, so no verdict is offered. A missing number is reported as missing rather than guessed.",
  },
  EVIDENCE_INCONSISTENT: {
    title: "Index disagrees with the chain",
    explanation:
      "The database and the chain disagree on something the verdict depends on, so the investigation stopped here. The reconciliation table below shows exactly which fields differ.",
  },
  EVIDENCE_INSUFFICIENT: {
    title: "Not verifiable as asked",
    explanation:
      "The payment is indexed but not in a state that can be verified right now. No verdict is asserted.",
  },
};

/** Assembles the full detail view model from an investigation result. */
export function toDetailPanel(
  result: InvestigationResult,
  options: {
    indexed: IndexedProvenance | null;
    network: NetworkInfo;
    asset: AssetInfo;
    explorerBaseUrl: string;
  },
): DetailPanelModel {
  const { indexed } = options;
  return {
    status: result.gating.length === 0 ? "COMPLETE" : "INSUFFICIENT_EVIDENCE",
    paymentId: result.request.paymentId,
    reference: result.request.reference,
    verdict: verdictModel(result),
    evidence: evidenceModel(result),
    investigator: investigatorModel(result),
    reconciliation: reconciliationModel(result),
    settlement: {
      lifecycle: result.context.paymentPresentOnChain
        ? lifecycleStatus(result.context.onChainStatus)
        : null,
      createdTxHash: indexed?.createdTxHash ?? null,
      approvedTxHash: indexed?.approvedTxHash ?? null,
      executedTxHash: indexed?.executedTxHash ?? null,
      createdBlockNumber: indexed?.createdBlockNumber ?? null,
      approvedBlockNumber: indexed?.approvedBlockNumber ?? null,
      executedBlockNumber: indexed?.executedBlockNumber ?? null,
      createdAt: indexed?.createdAt ?? null,
      executedAt: indexed?.executedTxAt ?? null,
      approvedBy: indexed?.approvedBy ?? null,
      executedBy: indexed?.executedBy ?? null,
      requestedBy: indexed?.requestedBy ?? null,
    },
    network: options.network,
    asset: options.asset,
    explorerBaseUrl: options.explorerBaseUrl,
  };
}

/**
 * Maps an investigation outcome onto what a page renders.
 *
 * A 422 carries a partial result and the partial is KEPT, not discarded: refusing to state a
 * verdict and refusing to show why are different failures.
 */
export function toDetailPage(
  outcome: InvestigationOutcome,
  options: {
    indexed: IndexedProvenance | null;
    network: NetworkInfo;
    asset: AssetInfo;
    explorerBaseUrl: string;
  },
): DetailPageModel {
  if (outcome.ok) {
    return { kind: "ok", detail: toDetailPanel(outcome.result, options) };
  }

  const copy = ERROR_COPY[outcome.error.code] ?? {
    title: "Investigation unavailable",
    explanation: outcome.error.message,
  };

  return {
    kind: "error",
    code: outcome.error.code,
    title: copy.title,
    explanation: copy.explanation,
    // Only a 422 populates this. Built from the SAME result, so the reconciliation a user is
    // shown is precisely the reconciliation that caused the refusal.
    partial: outcome.result ? toDetailPanel(outcome.result, options) : null,
  };
}