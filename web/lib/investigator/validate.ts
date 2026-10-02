import type {
  Finding,
  FindingType,
  InvestigatorRecommendation,
  InvestigatorResult,
} from "./types";
import type { EvidenceKeySet } from "./evidence-keys";

/**
 * Runtime validation of investigator output.
 *
 * EXPLICIT AND SMALL BY DESIGN. A validation library would be a dependency added for one
 * schema; this is a few dozen lines with no external surface, and it lets the failure modes
 * be exact — which matters more here than brevity, because the alternative to a precise
 * rejection is silently coercing model prose into a result that looks trustworthy.
 *
 * Two rules drive everything:
 *   1. REJECT, DO NOT COERCE. A missing or wrong-typed field is a failure, not a default.
 *      "Never silently coerce arbitrary model text into a valid investigation result."
 *   2. NO UNGROUNDED CITATION SURVIVES. Every `evidenceKeys` entry must resolve against the
 *      real evidence object.
 */

export const FINDING_TYPES: readonly FindingType[] = [
  "POLICY_PASS",
  "POLICY_FAIL",
  "ROLE_CONTEXT",
  "BALANCE",
  "RECIPIENT",
  "HISTORY",
  "STATE",
];

export const RECOMMENDATIONS: readonly InvestigatorRecommendation[] = [
  "PROCEED_TO_HUMAN_REVIEW",
  "NO_ACTION",
  "BLOCK",
  "INSUFFICIENT_EVIDENCE",
];

/** The exact field set the output schema declares. Anything else is rejected. */
const TOP_LEVEL_KEYS = new Set(["summary", "recommendation", "findings", "uncertainties", "authority"]);
const FINDING_KEYS = new Set(["type", "statement", "evidenceKeys"]);

export type ValidationOutcome =
  | { ok: true; value: InvestigatorResult }
  | { ok: false; reason: string; ungroundedCitationCount: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a parsed model response against the contract and the grounding boundary.
 *
 * On any failure the caller is expected to fall back to an INSUFFICIENT_EVIDENCE result that
 * is clearly marked INVALID_OUTPUT, rather than passing partial data through.
 */
export function validateInvestigatorResult(raw: unknown, allowedKeys: EvidenceKeySet): ValidationOutcome {
  if (!isRecord(raw)) return { ok: false, reason: "RESPONSE_NOT_AN_OBJECT", ungroundedCitationCount: 0 };

  // The schema declares additionalProperties: false, but a schema only binds a model that
  // honours it. Rejecting unknown top-level keys here closes the gap between what the model
  // was asked and what was actually checked — an extra `approve: true` must not ride along
  // inside a payload some future consumer might read more loosely than this validator does.
  const unexpected = Object.keys(raw).filter((k) => !TOP_LEVEL_KEYS.has(k));
  if (unexpected.length > 0) {
    return { ok: false, reason: "UNEXPECTED_TOP_LEVEL_FIELD", ungroundedCitationCount: 0 };
  }

  if (!nonEmptyString(raw.summary)) return { ok: false, reason: "SUMMARY_MISSING_OR_EMPTY", ungroundedCitationCount: 0 };

  if (typeof raw.recommendation !== "string" || !RECOMMENDATIONS.includes(raw.recommendation as InvestigatorRecommendation)) {
    return { ok: false, reason: "RECOMMENDATION_NOT_IN_ENUM", ungroundedCitationCount: 0 };
  }

  if (raw.authority !== "ADVISORY_ONLY") {
    return { ok: false, reason: "AUTHORITY_NOT_ADVISORY_ONLY", ungroundedCitationCount: 0 };
  }

  if (!Array.isArray(raw.findings)) return { ok: false, reason: "FINDINGS_NOT_AN_ARRAY", ungroundedCitationCount: 0 };

  const findings: Finding[] = [];
  let ungrounded = 0;
  for (let i = 0; i < raw.findings.length; i++) {
    const f = raw.findings[i];
    if (!isRecord(f)) return { ok: false, reason: `FINDING_${i}_NOT_AN_OBJECT`, ungroundedCitationCount: ungrounded };
    const unexpectedFinding = Object.keys(f).filter((k) => !FINDING_KEYS.has(k));
    if (unexpectedFinding.length > 0) {
      return { ok: false, reason: `FINDING_${i}_UNEXPECTED_FIELD`, ungroundedCitationCount: ungrounded };
    }
    if (typeof f.type !== "string" || !FINDING_TYPES.includes(f.type as FindingType)) {
      return { ok: false, reason: `FINDING_${i}_TYPE_NOT_IN_ENUM`, ungroundedCitationCount: ungrounded };
    }
    if (!nonEmptyString(f.statement)) {
      return { ok: false, reason: `FINDING_${i}_STATEMENT_MISSING_OR_EMPTY`, ungroundedCitationCount: ungrounded };
    }
    if (!Array.isArray(f.evidenceKeys)) {
      return { ok: false, reason: `FINDING_${i}_EVIDENCE_KEYS_NOT_AN_ARRAY`, ungroundedCitationCount: ungrounded };
    }
    // Every factual finding must be anchored to at least one real field. An empty citation
    // list is an ungrounded claim wearing the costume of a grounded one, so it is rejected
    // rather than treated as "no evidence needed".
    if (f.evidenceKeys.length === 0) {
      return { ok: false, reason: `FINDING_${i}_NO_EVIDENCE_CITATIONS`, ungroundedCitationCount: ungrounded };
    }
    const keys: string[] = [];
    for (const [j, k] of f.evidenceKeys.entries()) {
      if (!nonEmptyString(k)) {
        return { ok: false, reason: `FINDING_${i}_KEY_${j}_NOT_A_STRING`, ungroundedCitationCount: ungrounded };
      }
      if (!allowedKeys.keys.has(k)) ungrounded++;
      keys.push(k);
    }
    findings.push({ type: f.type as FindingType, statement: f.statement, evidenceKeys: keys });
  }

  if (ungrounded > 0) {
    // An unsupported claim is a grounding failure, not a warning. The whole result is
    // rejected so a fabricated citation can never reach a consumer as a finding.
    return { ok: false, reason: "UNGROUNDED_EVIDENCE_CITATION", ungroundedCitationCount: ungrounded };
  }

  if (!Array.isArray(raw.uncertainties)) {
    return { ok: false, reason: "UNCERTAINTIES_NOT_AN_ARRAY", ungroundedCitationCount: ungrounded };
  }
  const uncertainties: string[] = [];
  for (const [j, u] of raw.uncertainties.entries()) {
    if (typeof u !== "string") {
      return { ok: false, reason: `UNCERTAINTY_${j}_NOT_A_STRING`, ungroundedCitationCount: ungrounded };
    }
    uncertainties.push(u);
  }

  return {
    ok: true,
    value: {
      status: "OK",
      summary: raw.summary,
      recommendation: raw.recommendation as InvestigatorRecommendation,
      findings,
      uncertainties,
      authority: "ADVISORY_ONLY",
    },
  };
}