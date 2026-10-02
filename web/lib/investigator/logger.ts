import type {
  InvestigatorDiagnostics,
  InvestigatorRecommendation,
  InvestigatorResult,
} from "./types";
import { INVESTIGATOR_PROMPT_VERSION } from "./prompt";

/**
 * Safe diagnostics and safe fallbacks.
 *
 * NOTHING IN THIS FILE MAY LOG OR RETURN A SECRET. The redaction is structural rather than
 * conventional: `sanitiseDiagnostics` copies only a fixed allow-list of named fields into a
 * fresh object, so even if the upstream code accidentally handed us the API key, the key
 * could not survive into the diagnostics. Full evidence payloads are never logged — only
 * the evidence ID, which is a hash.
 */

const SAFE_STRING_LIMIT = 200;

/** Secret-ish environment values, never echoed back even in an error message. */
const SECRET_MARKERS = ["apikey", "api_key", "secret", "password", "token", "authorization", "privatekey", "private_key"];

export function redact(value: string): string {
  let out = value;
  for (const marker of SECRET_MARKERS) {
    // Replace anything that looks like `...MARKER...=<value>` with the marker alone.
    out = out.replace(new RegExp(`(${marker})[^\\s,;}"']*`, "gi"), "$1=[REDACTED]");
  }
  return out.length > SAFE_STRING_LIMIT ? `${out.slice(0, SAFE_STRING_LIMIT)}…` : out;
}

/** Reduces arbitrary provider error text to a short, non-secret, category-safe string. */
export function safeMessage(error: unknown): string {
  const base = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  return redact(base);
}

/**
 * Coerces HTTP status into a coarse category. The raw status is retained (it is not secret
 * and is diagnostically useful) but never the response body or headers.
 */
export function statusCategory(status: number | undefined): string {
  if (status === undefined) return "none";
  if (status >= 200 && status < 300) return "2xx";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

export type SafeLogFields = {
  provider: string;
  model: string;
  promptVersion: string;
  evidenceId: string;
  latencyMs: number;
  httpStatusCategory: string;
  validation: "PASSED" | "FAILED" | "NOT_RUN";
  failureReason?: string;
  ungroundedCitationCount?: number;
  recommendationConstrained?: boolean;
};

/** Emits a single-line structured diagnostic. Safe for production logs. */
export function logInvestigator(fields: {
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  httpStatusCategory: string;
  validation: "PASSED" | "FAILED" | "NOT_RUN";
  evidenceId?: string;
  failureReason?: string;
  ungroundedCitationCount?: number;
  recommendationConstrained?: boolean;
}): void {
  const parts = [
    `provider=${fields.provider}`,
    `model=${fields.model}`,
    `prompt=${fields.promptVersion}`,
    `evidenceId=${fields.evidenceId ?? "n/a"}`,
    `latencyMs=${fields.latencyMs}`,
    `http=${fields.httpStatusCategory}`,
    `validation=${fields.validation}`,
  ];
  if (fields.failureReason) parts.push(`failure=${redact(fields.failureReason)}`);
  if (fields.ungroundedCitationCount) parts.push(`ungrounded=${fields.ungroundedCitationCount}`);
  if (fields.recommendationConstrained) parts.push("recommendationConstrained=true");
  console.log(`[investigator] ${parts.join(" ")}`);
}

export function sanitiseDiagnostics(fields: SafeLogFields): InvestigatorDiagnostics {
  // Built by explicit field copy: an unexpected extra key cannot ride along.
  const out: InvestigatorDiagnostics = {
    provider: fields.provider,
    model: fields.model,
    promptVersion: fields.promptVersion,
    latencyMs: fields.latencyMs,
    httpStatusCategory: fields.httpStatusCategory,
    validation: fields.validation,
  };
  if (fields.failureReason) out.failureReason = redact(fields.failureReason);
  if (fields.ungroundedCitationCount !== undefined) out.ungroundedCitationCount = fields.ungroundedCitationCount;
  if (fields.recommendationConstrained !== undefined) {
    out.recommendationConstrained = fields.recommendationConstrained;
  }
  return out;
}

/**
 * The only way an investigation reports failure.
 *
 * Crucially, this produces an ADVISORY result — it never changes the deterministic decision,
 * because the deterministic decision is not an input to this function at all. A provider
 * outage cannot become a policy verdict; it can only produce an explanation that says
 * nothing useful is available.
 *
 * The reason is always recorded in `diagnostics.failureReason` (and mirrored in
 * `uncertainties`) so an operator can tell a provider outage apart from a genuine finding.
 */
export function fallbackResult(
  status: InvestigatorResult["status"],
  reason: string,
  recommendation: InvestigatorRecommendation = "INSUFFICIENT_EVIDENCE",
  meta?: {
    provider: string;
    model: string;
    latencyMs?: number;
    httpStatusCategory?: string;
    ungroundedCitationCount?: number;
  },
): InvestigatorResult {
  return {
    status,
    summary: `AI investigator ${status === "UNAVAILABLE" ? "unavailable" : "produced invalid output"}; no explanation available.`,
    recommendation,
    findings: [],
    uncertainties: [`Investigator ${status}: ${reason}`],
    authority: "ADVISORY_ONLY",
    diagnostics: {
      provider: meta?.provider ?? "unknown",
      model: meta?.model ?? "unknown",
      promptVersion: INVESTIGATOR_PROMPT_VERSION,
      latencyMs: meta?.latencyMs ?? 0,
      httpStatusCategory: meta?.httpStatusCategory ?? "none",
      validation: status === "INVALID_OUTPUT" ? "FAILED" : "NOT_RUN",
      failureReason: redact(reason),
      ...(meta?.ungroundedCitationCount !== undefined ? { ungroundedCitationCount: meta.ungroundedCitationCount } : {}),
    },
  };
}