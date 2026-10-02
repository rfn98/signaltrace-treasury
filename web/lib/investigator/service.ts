import type {
  InvestigatorInput,
  InvestigatorProvider,
  InvestigatorRecommendation,
  InvestigatorResult,
  PolicyDecision,
} from "./types";
import { fallbackResult, logInvestigator, sanitiseDiagnostics, statusCategory, type SafeLogFields } from "./logger";
import { INVESTIGATOR_PROMPT_VERSION } from "./prompt";
import { validateInvestigatorResult } from "./validate";
import { deriveEvidenceKeys, type EvidenceKeySet } from "./evidence-keys";
import { canonicalJson } from "@/lib/evidence/canonical";
import type { Evidence } from "@/lib/evidence/build";

/**
 * The investigator application service.
 *
 * This is the single place where the deterministic verdict and the AI explanation are
 * combined, and it is where the security boundary is enforced rather than merely intended:
 *
 *   - `policyDecision` is taken from the deterministic evaluator and is NEVER recomputed,
 *     never overwritten, and never even passed to the constraint function as something it
 *     could change. There is no code path from `investigator` to `policyDecision`.
 *   - The recommendation is clamped so the AI cannot recommend proceeding for a request the
 *     deterministic engine blocked.
 *   - A provider failure downgrades only the explanation. The deterministic result stands.
 *
 * The service imports nothing from Prisma, the chain adapter, or the policy evaluator's
 * internals: it receives an already-built evidence record and an already-decided verdict.
 */

export type InvestigationOutcome = {
  /** AUTHORITATIVE. Produced by the deterministic evaluator. Never influenced by the AI. */
  policyDecision: PolicyDecision;
  /** The deterministic ReasonCode that explains `policyDecision`. */
  deterministicReason: number;
  evidenceIntegrityHash: string;
  investigator: InvestigatorResult;
};

const RECOMMENDATIONS_FOR_BLOCKED: readonly InvestigatorRecommendation[] = ["BLOCK", "NO_ACTION", "INSUFFICIENT_EVIDENCE"];

/**
 * Clamps an advisory recommendation so it can never contradict the authoritative decision.
 *
 * The asymmetry is deliberate and is the whole point of the boundary:
 *
 *   - For BLOCKED, an "upgrade" recommendation (PROCEED_TO_HUMAN_REVIEW) is rejected and
 *     replaced with INSUFFICIENT_EVIDENCE, because the deterministic engine has already
 *     refused the request and no amount of prose can re-open it.
 *   - For PENDING and AUTO_APPROVED, a *more* cautious recommendation is left alone. Cautious
 *     advice is harmless: it can delay a human, never authorize a payment.
 *
 * Note this clamps the RECOMMENDATION only. `policyDecision` is not an output of this
 * function and cannot be influenced by it.
 */
export function constrainRecommendation(
  decision: PolicyDecision,
  recommendation: InvestigatorRecommendation,
): { recommendation: InvestigatorRecommendation; constrained: boolean } {
  if (decision === "BLOCKED" && !RECOMMENDATIONS_FOR_BLOCKED.includes(recommendation)) {
    return { recommendation: "INSUFFICIENT_EVIDENCE", constrained: true };
  }
  return { recommendation, constrained: false };
}

export type InvestigateParams = {
  evidence: Evidence;
  policyDecision: PolicyDecision;
  deterministicReason: number;
  provider: InvestigatorProvider;
  /** Model name for diagnostics only. */
  model: string;
};

/**
 * Fields the G policy engine actually evaluates. If one is absent there is no evidence to
 * reason about, so no explanation is produced. Names are Milestone G paths, checked against
 * the derived key set rather than against a hand-written list of field names, so a rename in
 * the evidence builder surfaces here as a test failure instead of as a silently weakened
 * pre-flight check.
 */
const REQUIRED_EVIDENCE_KEYS: readonly string[] = [
  "request.amountBaseUnits",
  "request.to",
  "policy.autoApproveLimit",
  "policy.singleTxLimit",
  "policy.dailyLimit",
  "policy.monthlyLimit",
  "recipient.approved",
  "budget.treasuryBalanceBaseUnits",
  "decision.offchainDecision",
  "decision.reason",
];

type PreflightFailure = { status: InvestigatorResult["status"]; reason: string };

/**
 * Rejects evidence that cannot support any explanation.
 *
 * Returns `null` when the evidence is good enough to investigate.
 */
export function checkEvidenceIntegrity(
  evidence: Evidence,
  grounding: EvidenceKeySet,
  policyDecision: PolicyDecision,
  deterministicReason: number,
): PreflightFailure | null {
  const embedded = evidence?.decision?.offchainDecision;
  if (embedded !== policyDecision) {
    // Contradiction: the record and the verdict disagree. Deliberately does not pick a winner.
    return { status: "UNAVAILABLE", reason: `EVIDENCE_DECISION_CONTRADICTS_VERDICT_${embedded ?? "MISSING"}` };
  }

  // The reason code travels alongside the verdict, so it is checked the same way. A verdict
  // that is right but explained by a different reason would send an operator and an auditor
  // reading two different stories about the same payment.
  const embeddedReason = evidence?.decision?.reason;
  if (typeof embeddedReason !== "number" || embeddedReason !== deterministicReason) {
    return { status: "UNAVAILABLE", reason: `EVIDENCE_REASON_CONTRADICTS_VERDICT_${embeddedReason ?? "MISSING"}` };
  }

  const missing = REQUIRED_EVIDENCE_KEYS.filter((key) => !grounding.keys.has(key));
  if (missing.length > 0) {
    return { status: "INVALID_OUTPUT", reason: `EVIDENCE_MISSING_REQUIRED_FIELDS_${missing.join("_")}` };
  }

  return null;
}

/**
 * Runs the advisory layer over deterministic evidence.
 *
 * NEVER THROWS for provider reasons: every failure path resolves to an advisory result whose
 * `status` explains what happened. A caller can therefore always read `policyDecision`.
 */
export async function investigate(params: InvestigateParams): Promise<InvestigationOutcome> {
  const { evidence, policyDecision, deterministicReason, provider, model } = params;
  const evidenceJson = canonicalJson(evidence);
  const evidenceId = evidence.integrityHash.replace(/^sha256:/, "").slice(0, 16);
  const started = Date.now();

  const input: InvestigatorInput = { evidenceJson, deterministicDecision: policyDecision, evidenceId };

  // PRE-FLIGHT: the evidence must be internally consistent before it is worth asking a model
  // to explain it. Two failures are checked here:
  //
  //   1. CONTRADICTION. The evidence carries its own `decision.offchainDecision`, which came
  //      from the G engine. If it disagrees with the `policyDecision` handed to us, then one
  //      of the two is wrong and no explanation of the disagreement would be meaningful — so
  //      the AI is not called at all. The caller's decision is still returned untouched.
  //   2. MISSING REQUIRED FIELDS. An explanation of absent evidence is not an explanation;
  //      it is speculation. When a field the policy checks on is missing, the result is
  //      INSUFFICIENT_EVIDENCE rather than a plausible-sounding narrative.
  const grounding = deriveEvidenceKeys(JSON.parse(evidenceJson) as unknown);
  const preflight = checkEvidenceIntegrity(evidence, grounding, policyDecision, deterministicReason);
  if (preflight) {
    const fallback = fallbackResult(preflight.status, preflight.reason, "INSUFFICIENT_EVIDENCE", {
      provider: provider.name,
      model,
      latencyMs: 0,
    });
    fallback.diagnostics = sanitiseDiagnostics({
      provider: provider.name,
      model,
      promptVersion: INVESTIGATOR_PROMPT_VERSION,
      evidenceId,
      latencyMs: 0,
      httpStatusCategory: statusCategory(undefined),
      validation: preflight.status === "INVALID_OUTPUT" ? "FAILED" : "NOT_RUN",
      failureReason: preflight.reason,
    });
    logInvestigator({ ...fallback.diagnostics, evidenceId });
    return {
      policyDecision,
      deterministicReason,
      evidenceIntegrityHash: evidence.integrityHash,
      investigator: fallback,
    };
  }

  let result: InvestigatorResult;
  try {
    result = await provider.investigate(input);
  } catch {
    // A provider that throws is treated exactly like one that fails: the explanation is
    // unavailable, the deterministic decision is untouched.
    result = fallbackResult("UNAVAILABLE", "PROVIDER_THREW", "INSUFFICIENT_EVIDENCE", { provider: provider.name, model });
  }

  // INDEPENDENT RE-VALIDATION.
  //
  // The provider's self-reported `status` is never taken on trust. Even a well-behaved
  // provider could return a result that does not satisfy the contract — and a compromised or
  // substituted provider could return one that claims `status: "OK"` while carrying a
  // fabricated citation or a non-advisory `authority`. So the service re-runs the validator
  // and the grounding check against the very evidence it holds, and only a result that
  // passes here is treated as a real explanation. This is the difference between the boundary
  // being enforced and merely documented.
  const revalidated = validateInvestigatorResult(
    {
      summary: result?.summary,
      recommendation: result?.recommendation,
      findings: result?.findings,
      uncertainties: result?.uncertainties,
      authority: result?.authority,
    },
    grounding,
  );

  // When re-validation passes, adopt the validator's NORMALISED value rather than the provider's
  // own object. Spreading `result` here would carry every field the model invented straight past
  // the allowlist that was just enforced on it — an extra `approve: true` or `policyOverride`
  // would reach a caller that trusted the boundary was real. Building from `revalidated.value`
  // is what makes the projection load-bearing instead of decorative.
  let accepted: InvestigatorResult | null = null;

  if (!revalidated.ok) {
    result = fallbackResult("INVALID_OUTPUT", revalidated.reason, "INSUFFICIENT_EVIDENCE", {
      provider: provider.name,
      model,
      ...(revalidated.ungroundedCitationCount > 0 ? { ungroundedCitationCount: revalidated.ungroundedCitationCount } : {}),
    });
  } else if (result.status !== "OK") {
    // The provider itself reported a non-OK status; keep that diagnosis, but keep the
    // fallback (empty findings, advisory authority) rather than adopting partial output.
    result = fallbackResult(result.status, result.diagnostics?.failureReason ?? "PROVIDER_REPORTED_NON_OK", result.recommendation, {
      provider: provider.name,
      model,
    });
  } else {
    accepted = revalidated.value;
  }

  const constrained = constrainRecommendation(policyDecision, (accepted ?? result).recommendation);
  const investigator: InvestigatorResult = accepted
    ? {
        status: accepted.status,
        summary: accepted.summary,
        recommendation: constrained.recommendation,
        findings: accepted.findings,
        uncertainties: accepted.uncertainties,
        authority: "ADVISORY_ONLY",
      }
    : { ...result, recommendation: constrained.recommendation, authority: "ADVISORY_ONLY" };

  const validation: SafeLogFields["validation"] =
    investigator.status === "OK" ? "PASSED" : investigator.status === "INVALID_OUTPUT" ? "FAILED" : "NOT_RUN";

  const diagnostics = sanitiseDiagnostics({
    provider: provider.name,
    model,
    promptVersion: INVESTIGATOR_PROMPT_VERSION,
    evidenceId,
    latencyMs: Date.now() - started,
    httpStatusCategory: investigator.diagnostics?.httpStatusCategory ?? statusCategory(undefined),
    validation,
    ...(investigator.diagnostics?.failureReason ? { failureReason: investigator.diagnostics.failureReason } : {}),
    ...(investigator.diagnostics?.ungroundedCitationCount !== undefined
      ? { ungroundedCitationCount: investigator.diagnostics.ungroundedCitationCount }
      : {}),
    recommendationConstrained: constrained.constrained,
  });

  investigator.diagnostics = diagnostics;
  logInvestigator({ ...diagnostics, evidenceId });

  return {
    policyDecision,
    deterministicReason,
    evidenceIntegrityHash: evidence.integrityHash,
    investigator,
  };
}