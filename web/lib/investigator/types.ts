/**
 * Milestone H — AI Investigator types.
 *
 * THE ONE RULE THAT SHAPES THIS FILE: the investigator is an EXPLANATION layer. Every type
 * here is descriptive. Nothing in it can approve a payment, alter policy, or move funds.
 * The authoritative decision is produced by the deterministic evaluator and is carried
 * alongside — never inside — the investigator output.
 */

/** Mirrors the deterministic evaluator's verdicts. Never widened by the AI. */
export type PolicyDecision = "AUTO_APPROVED" | "PENDING" | "BLOCKED";

/**
 * Advisory recommendation. `PROCEED_TO_HUMAN_REVIEW` means "a human may look at this",
 * never "this may execute". The distinction is enforced in `service.ts`.
 */
export type InvestigatorRecommendation =
  | "PROCEED_TO_HUMAN_REVIEW"
  | "NO_ACTION"
  | "BLOCK"
  | "INSUFFICIENT_EVIDENCE";

export type FindingType =
  | "POLICY_PASS"
  | "POLICY_FAIL"
  | "ROLE_CONTEXT"
  | "BALANCE"
  | "RECIPIENT"
  | "HISTORY"
  | "STATE";

export type Finding = {
  type: FindingType;
  statement: string;
  /**
   * Dotted paths into the evidence object that was supplied to the model, e.g.
   * `request.amountBaseUnits`. Every key MUST resolve against the real evidence; a key that
   * does not exist is rejected as an unsupported claim rather than trusted as prose.
   */
  evidenceKeys: string[];
};

/**
 * Whether the investigation actually happened. Separate from the recommendation so a
 * provider outage is never mistaken for a substantive finding.
 */
export type InvestigatorStatus = "OK" | "UNAVAILABLE" | "INVALID_OUTPUT";

export type InvestigatorResult = {
  status: InvestigatorStatus;
  summary: string;
  recommendation: InvestigatorRecommendation;
  findings: Finding[];
  uncertainties: string[];
  /** Fixed constant. Present so a consumer cannot be handed anything else. */
  authority: "ADVISORY_ONLY";
  diagnostics?: InvestigatorDiagnostics;
};

/**
 * Safe, non-secret diagnostics. Deliberately structured rather than a free log string so a
 * secret cannot be smuggled into it: the type admits only these named, non-sensitive
 * fields, and `redactDiagnostics` strips anything else before it is attached.
 */
export type InvestigatorDiagnostics = {
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  /** e.g. "2xx", "4xx", "5xx", "timeout", "network". Never the raw body or headers. */
  httpStatusCategory: string;
  validation: "PASSED" | "FAILED" | "NOT_RUN";
  /** Coarse, non-secret reason code (e.g. "MISSING_API_KEY"). */
  failureReason?: string;
  /** Count of findings whose evidence keys failed grounding. */
  ungroundedCitationCount?: number;
  /** True when the model's recommendation contradicted the deterministic decision. */
  recommendationConstrained?: boolean;
};

/**
 * What the provider is given. Note what is absent: no Prisma client, no RPC handle, no
 * wallet, no filesystem, no credentials. A serialized evidence object and the authoritative
 * decision are the entire input surface.
 */
export type InvestigatorInput = {
  /** Canonical JSON text of the Milestone G evidence record. */
  evidenceJson: string;
  /** The deterministic verdict, which the model must explain and may not contradict. */
  deterministicDecision: PolicyDecision;
  /** Stable id for correlating logs, derived from the evidence hash. */
  evidenceId: string;
};

export interface InvestigatorProvider {
  readonly name: string;
  investigate(input: InvestigatorInput): Promise<InvestigatorResult>;
}