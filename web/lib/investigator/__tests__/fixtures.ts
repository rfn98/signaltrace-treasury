import type {
  InvestigatorInput,
  InvestigatorProvider,
  InvestigatorResult,
  PolicyDecision,
} from "@/lib/investigator/types";
import { buildCreationEvidence } from "@/lib/evidence/build";
import {
  CHAIN_ID,
  MIL_E_POLICY,
  RECIPIENT_MILESTONE_E,
  TREASURY_ADDRESS,
} from "@/lib/policy/types";

/**
 * Test fixtures. Everything here is offline and deterministic: no network, no credentials,
 * no API credits.
 *
 * The evidence fixtures are built by the REAL Milestone G evidence builder rather than being
 * hand-written objects. That matters for the grounding tests: if a citation such as
 * `checks.SINGLE_TX_LIMIT.limitBaseUnits` is accepted, it is because that key genuinely
 * exists in real evidence — not because a test stub was shaped to make it pass.
 */

/** One real-evidence builder, parameterised only by the amount the policy turns on. */
function buildRealEvidence(amount: bigint, reference: string) {
  return buildCreationEvidence({
    chainId: CHAIN_ID,
    treasuryAddress: TREASURY_ADDRESS,
    to: RECIPIENT_MILESTONE_E,
    amount,
    category: "MILESTONE-E",
    reference,
    policy: MIL_E_POLICY,
    recipient: { approved: true, category: "MILESTONE-E" },
    counters: {
      reservedDay: {},
      reservedMonth: {},
      spentDay: {},
      spentMonth: {},
      lifetimeReserved: 0n,
      lifetimeSpent: 60_000_000n,
      balance: 140_000_000n,
      paused: false,
    },
    dayKey: 20726n,
    monthKey: 24321n,
    observedAtBlockNumber: 314303200n,
    observedAtBlockTimestamp: 1_790_774_100n,
  });
}

function assertDecision(evidence: ReturnType<typeof buildRealEvidence>, expected: PolicyDecision) {
  if (evidence.decision.offchainDecision !== expected) {
    throw new Error(
      `fixture expected ${expected}, builder produced ${evidence.decision.offchainDecision} — policy limits changed?`,
    );
  }
  return evidence;
}

export function makeEvidence(amount = 10_000_000n, recipient = RECIPIENT_MILESTONE_E, category = "MILESTONE-E") {
  const evidence = buildCreationEvidence({
    chainId: CHAIN_ID,
    treasuryAddress: TREASURY_ADDRESS,
    to: recipient,
    amount,
    category,
    reference: "0xabc123",
    policy: MIL_E_POLICY,
    recipient: { approved: true, category },
    counters: {
      reservedDay: {},
      reservedMonth: {},
      spentDay: {},
      spentMonth: {},
      lifetimeReserved: 0n,
      lifetimeSpent: 60_000_000n,
      balance: 140_000_000n,
      paused: false,
    },
    dayKey: 20726n,
    monthKey: 24321n,
    observedAtBlockNumber: 314303200n,
    observedAtBlockTimestamp: 1_790_774_100n,
  });
  return evidence;
}

/**
 * Genuinely pending evidence: above the auto-approval limit but inside every hard limit, so
 * the real G engine really does return PENDING. This is the path a human would have to
 * review, which is exactly the case where an advisory explanation matters most.
 */
export function makePendingEvidence() {
  return assertDecision(buildRealEvidence(50_000_000n, "0xpending"), "PENDING");
}

/**
 * Genuinely blocked evidence, built by the real G engine.
 *
 * The amount is far above every configured limit, so the deterministic engine really does
 * return BLOCKED. Tests that exercise the BLOCKED path need evidence that agrees with the
 * verdict they pass: handing the service a BLOCKED verdict alongside evidence the engine
 * marked AUTO_APPROVED would be testing a contradiction rather than the constraint.
 */
export function makeBlockedEvidence(reason?: string) {
  return assertDecision(buildRealEvidence(900_000_000_000n, reason ?? "0xdef456"), "BLOCKED");
}

/**
 * Evidence that genuinely agrees with a verdict.
 *
 * The service refuses evidence whose embedded `decision.offchainDecision` contradicts the
 * verdict it is handed, so any test that passes a particular decision must pass evidence
 * that the real G engine actually decided that way. This keeps tests honest: they exercise a
 * real BLOCKED or PENDING path rather than a fabricated one.
 */
export function evidenceForDecision(decision: PolicyDecision) {
  if (decision === "BLOCKED") return makeBlockedEvidence();
  if (decision === "PENDING") return makePendingEvidence();
  return assertDecision(buildRealEvidence(10_000_000n, "0xauto"), "AUTO_APPROVED");
}

/** A provider that returns a fixed result and records what it was asked. */
export class MockInvestigatorProvider implements InvestigatorProvider {
  readonly name = "mock";
  readonly calls: InvestigatorInput[] = [];

  constructor(private readonly behaviour: (input: InvestigatorInput) => Promise<InvestigatorResult>) {}

  async investigate(input: InvestigatorInput): Promise<InvestigatorResult> {
    this.calls.push(input);
    return this.behaviour(input);
  }
}

/** A provider that returns a fixed, valid result. */
export function staticProvider(result: Partial<InvestigatorResult>): MockInvestigatorProvider {
  return new MockInvestigatorProvider(async () => ({
    status: "OK",
    summary: "The request satisfies the observed policy checks.",
    recommendation: "PROCEED_TO_HUMAN_REVIEW",
    findings: [
      {
        type: "POLICY_PASS",
        statement: "Amount is below the configured auto-approval limit.",
        evidenceKeys: ["request.amountBaseUnits", "policy.autoApproveLimit"],
      },
    ],
    uncertainties: [],
    authority: "ADVISORY_ONLY",
    ...result,
  }));
}

/** A provider that fails in the way the test needs. */
export function failingProvider(mode: "throw" | "unavailable"): MockInvestigatorProvider {
  return new MockInvestigatorProvider(async () => {
    if (mode === "throw") throw new Error("provider exploded");
    return {
      status: "UNAVAILABLE",
      summary: "AI investigator unavailable; no explanation available.",
      recommendation: "INSUFFICIENT_EVIDENCE",
      findings: [],
      uncertainties: ["Investigator UNAVAILABLE: PROVIDER_UNAVAILABLE"],
      authority: "ADVISORY_ONLY",
      diagnostics: {
        provider: "mock",
        model: "gpt-oss:20b",
        promptVersion: "signaltrace-investigator-v1",
        latencyMs: 5,
        httpStatusCategory: "5xx",
        validation: "NOT_RUN",
        failureReason: "PROVIDER_UNAVAILABLE",
      },
    };
  });
}

export const DECISIONS: PolicyDecision[] = ["AUTO_APPROVED", "PENDING", "BLOCKED"];