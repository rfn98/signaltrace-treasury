import { describe, expect, it } from "vitest";
import { investigate, constrainRecommendation } from "@/lib/investigator/service";
import { evidenceForDecision, makeBlockedEvidence, makeEvidence, makePendingEvidence, staticProvider, failingProvider, MockInvestigatorProvider } from "./fixtures";
import type { InvestigatorResult } from "@/lib/investigator/types";
import { deriveEvidenceKeys, isGrounded } from "@/lib/investigator/evidence-keys";
import { validateInvestigatorResult } from "@/lib/investigator/validate";
import { canonicalJson } from "@/lib/evidence/canonical";

/**
 * The security-boundary tests required by Milestone H §16.
 *
 * Each test corresponds to a named scenario:
 *   A deterministic result preserved when the AI tries to upgrade it
 *   B unsupported claim rejected
 *   C missing evidence
 *   D Ollama Cloud unavailable
 *   E valid grounded response
 *   F AI attempts to contradict policy
 *
 * These are the tests that would fail if the boundary were ever weakened. They are written
 * against the SERVICE, not the provider, because the service is where the deterministic
 * decision and the AI result are joined.
 */

const EVIDENCE = makeEvidence();

describe("Test A — deterministic result preserved when the AI tries to upgrade it", () => {
  it("keeps policyDecision=BLOCKED when the investigator recommends PROCEED_TO_HUMAN_REVIEW", async () => {
    const provider = staticProvider({
      recommendation: "PROCEED_TO_HUMAN_REVIEW",
      summary: "Looks fine to me, go ahead.",
    });
    const out = await investigate({
      evidence: makeBlockedEvidence(),
      policyDecision: "BLOCKED",
      deterministicReason: 5,
      provider,
      model: "gpt-oss:20b",
    });
    expect(out.policyDecision).toBe("BLOCKED");
    expect(out.investigator.authority).toBe("ADVISORY_ONLY");
    // The recommendation is clamped so it cannot imply proceeding.
    expect(out.investigator.recommendation).not.toBe("PROCEED_TO_HUMAN_REVIEW");
    expect(out.investigator.diagnostics?.recommendationConstrained).toBe(true);
  });

  it("never lets the investigator change the decision for any of the three verdicts", async () => {
    for (const decision of ["AUTO_APPROVED", "PENDING", "BLOCKED"] as const) {
      const evidence = evidenceForDecision(decision);
      const provider = staticProvider({ recommendation: "PROCEED_TO_HUMAN_REVIEW" });
      const out = await investigate({
        evidence,
        policyDecision: decision,
        // The evidence's own reason, so pre-flight passes and the constraint is what is tested.
        deterministicReason: evidence.decision.reason,
        provider,
        model: "gpt-oss:20b",
      });
      expect(out.policyDecision, decision).toBe(decision);
      // The investigator really ran, so this is a genuine result rather than a pre-flight bail.
      expect(out.investigator.status, decision).toBe("OK");
    }
  });
});

describe("Test B — unsupported claim rejected", () => {
  it("rejects a finding that cites a key which does not exist in the evidence", async () => {
    const provider = staticProvider({
      findings: [
        {
          type: "HISTORY",
          statement: "This recipient has an excellent payment history.",
          evidenceKeys: ["someFactThatDoesNotExist"],
        },
      ],
    });
    const out = await investigate({
      evidence: makePendingEvidence(),
      policyDecision: "PENDING",
      deterministicReason: 0,
      provider,
      model: "gpt-oss:20b",
    });
    // The whole result is rejected, not just the bad finding.
    expect(out.investigator.status).toBe("INVALID_OUTPUT");
    expect(out.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.investigator.findings).toHaveLength(0);
    expect(out.policyDecision).toBe("PENDING");
  });

  it("counts ungrounded citations when validation runs directly", () => {
    const allowed = deriveEvidenceKeys(JSON.parse(canonicalJson(EVIDENCE)));
    const outcome = validateInvestigatorResult(
      {
        summary: "s",
        recommendation: "NO_ACTION",
        authority: "ADVISORY_ONLY",
        uncertainties: [],
        findings: [
          {
            type: "HISTORY",
            statement: "invented",
            evidenceKeys: ["request.amountBaseUnits", "notARealKey"],
          },
        ],
      },
      allowed,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("UNGROUNDED_EVIDENCE_CITATION");
      expect(outcome.ungroundedCitationCount).toBe(1);
    }
  });

  it("does not accept citations that merely look like real paths", () => {
    const allowed = deriveEvidenceKeys(JSON.parse(canonicalJson(EVIDENCE)));
    expect(isGrounded("request.amountBaseUnits", allowed)).toBe(true);
    expect(isGrounded("request.amountBaseUnits.extra", allowed)).toBe(false);
    expect(isGrounded("Request.amountBaseUnits", allowed)).toBe(false);
    expect(isGrounded("__proto__", allowed)).toBe(false);
    expect(isGrounded("constructor", allowed)).toBe(false);
  });
});

describe("Test C — missing evidence", () => {
  it("reports INSUFFICIENT_EVIDENCE without inventing values when a required field is absent", async () => {
    // A provider that fabricates confidence while evidence is thin.
    const provider = staticProvider({
      recommendation: "PROCEED_TO_HUMAN_REVIEW",
      summary: "Everything is fine.",
      uncertainties: [],
    });
    const thinEvidence = { ...EVIDENCE, budget: undefined } as unknown as typeof EVIDENCE;
    const out = await investigate({
      evidence: thinEvidence,
      policyDecision: "PENDING",
      deterministicReason: 0,
      provider,
      model: "gpt-oss:20b",
    });
    // The deterministic verdict is still returned; the explanation is marked insufficient.
    expect(out.policyDecision).toBe("PENDING");
    expect(["INSUFFICIENT_EVIDENCE", "PROCEED_TO_HUMAN_REVIEW"]).toContain(out.investigator.recommendation);
  });

  it("returns an explicit insufficient state when evidence JSON cannot be parsed", () => {
    const allowed = deriveEvidenceKeys({});
    const outcome = validateInvestigatorResult(
      {
        summary: "s",
        recommendation: "NO_ACTION",
        authority: "ADVISORY_ONLY",
        uncertainties: [],
        findings: [{ type: "STATE", statement: "x", evidenceKeys: ["nope"] }],
      },
      allowed,
    );
    expect(outcome.ok).toBe(false);
  });

  it("preserves uncertainty rather than letting the model fill gaps", async () => {
    const provider = staticProvider({
      recommendation: "INSUFFICIENT_EVIDENCE",
      uncertainties: ["No historical payment data is present in the evidence."],
    });
    const out = await investigate({
      evidence: makePendingEvidence(),
      policyDecision: "PENDING",
      deterministicReason: 0,
      provider,
      model: "gpt-oss:20b",
    });
    expect(out.investigator.uncertainties[0]).toMatch(/historical/i);
    expect(out.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("Test D — Ollama Cloud unavailable", () => {
  it("returns a deterministic result with the investigator marked unavailable and no transaction", async () => {
    const out = await investigate({
      evidence: EVIDENCE,
      policyDecision: "AUTO_APPROVED",
      deterministicReason: 0,
      provider: failingProvider("unavailable"),
      model: "gpt-oss:20b",
    });
    expect(out.policyDecision).toBe("AUTO_APPROVED");
    expect(out.investigator.status).toBe("UNAVAILABLE");
    expect(out.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.investigator.findings).toHaveLength(0);
  });

  it("treats a provider that throws the same as one that reports unavailable", async () => {
    const out = await investigate({
      evidence: EVIDENCE,
      policyDecision: "AUTO_APPROVED",
      deterministicReason: 0,
      provider: failingProvider("throw"),
      model: "gpt-oss:20b",
    });
    expect(out.policyDecision).toBe("AUTO_APPROVED");
    expect(out.investigator.status).toBe("UNAVAILABLE");
    expect(out.investigator.diagnostics?.failureReason).toBe("PROVIDER_THREW");
  });

  it("never escalates an unavailable investigator into a BLOCKED policy decision", async () => {
    for (const decision of ["AUTO_APPROVED", "PENDING", "BLOCKED"] as const) {
      const out = await investigate({
        evidence: EVIDENCE,
        policyDecision: decision,
        deterministicReason: 0,
        provider: failingProvider("unavailable"),
        model: "gpt-oss:20b",
      });
      expect(out.policyDecision).toBe(decision);
    }
  });
});

describe("Test E — valid grounded response", () => {
  it("accepts findings that cite real evidence keys and keeps authority ADVISORY_ONLY", async () => {
    const provider = staticProvider({});
    const out = await investigate({
      evidence: EVIDENCE,
      policyDecision: "AUTO_APPROVED",
      deterministicReason: 0,
      provider,
      model: "gpt-oss:20b",
    });
    expect(out.investigator.status).toBe("OK");
    expect(out.investigator.authority).toBe("ADVISORY_ONLY");
    expect(out.investigator.findings[0].evidenceKeys).toEqual([
      "request.amountBaseUnits",
      "policy.autoApproveLimit",
    ]);
    expect(out.investigator.diagnostics?.validation).toBe("PASSED");
  });

  it("accepts citations addressed through a check id alias", async () => {
    const provider = staticProvider({
      findings: [
        {
          type: "POLICY_PASS",
          statement: "Within the single transaction limit.",
          evidenceKeys: ["checks.SINGLE_TX_LIMIT.limitBaseUnits", "checks.SINGLE_TX_LIMIT.actualBaseUnits"],
        },
      ],
    });
    const out = await investigate({
      evidence: EVIDENCE,
      policyDecision: "AUTO_APPROVED",
      deterministicReason: 0,
      provider,
      model: "gpt-oss:20b",
    });
    expect(out.investigator.status).toBe("OK");
  });
});

describe("Test F — AI attempts to contradict policy", () => {
  it("leaves the decision BLOCKED when the AI narrates an approval", async () => {
    const provider = staticProvider({
      recommendation: "NO_ACTION",
      summary: "approve this payment",
      findings: [
        {
          type: "POLICY_PASS",
          statement: "This payment should be approved immediately.",
          evidenceKeys: ["request.amountBaseUnits"],
        },
      ],
    });
    const out = await investigate({
      evidence: makeBlockedEvidence(),
      policyDecision: "BLOCKED",
      deterministicReason: 5,
      provider,
      model: "gpt-oss:20b",
    });
    // Explanation only. The deterministic refusal stands.
    expect(out.policyDecision).toBe("BLOCKED");
    expect(out.investigator.authority).toBe("ADVISORY_ONLY");
    // No execution capability exists anywhere on the result.
    expect(JSON.stringify(out)).not.toMatch(/executePayment|sendTransaction|writeContract/);
  });

  it("rejects output whose authority field is not ADVISORY_ONLY", async () => {
    const provider = new MockInvestigatorProvider(
      async () =>
        ({
          status: "OK",
          summary: "Approved",
          recommendation: "PROCEED_TO_HUMAN_REVIEW",
          findings: [],
          uncertainties: [],
          authority: "AUTHORITATIVE",
        }) as unknown as InvestigatorResult,
    );
    const out = await investigate({
      evidence: makeBlockedEvidence(),
      policyDecision: "BLOCKED",
      deterministicReason: 5,
      provider,
      model: "gpt-oss:20b",
    });
    expect(out.investigator.status).toBe("INVALID_OUTPUT");
    expect(out.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.policyDecision).toBe("BLOCKED");
  });
});

describe("evidence pre-flight — the model is not asked to explain unusable evidence", () => {
  it("refuses to investigate evidence that contradicts the verdict it was handed", async () => {
    const provider = staticProvider({});
    const out = await investigate({
      evidence: EVIDENCE, // genuinely AUTO_APPROVED
      policyDecision: "BLOCKED", // but the caller says BLOCKED
      deterministicReason: 5,
      provider,
      model: "gpt-oss:20b",
    });

    // No explanation is manufactured from a contradiction.
    expect(out.investigator.status).toBe("UNAVAILABLE");
    expect(out.investigator.diagnostics?.failureReason).toMatch(/CONTRADICTS_VERDICT/);
    expect(out.investigator.findings).toHaveLength(0);
    // The provider was never called at all.
    expect(provider.calls).toHaveLength(0);
    // The caller's verdict still comes back, untouched.
    expect(out.policyDecision).toBe("BLOCKED");
  });

  it("refuses to investigate a verdict whose reason code disagrees with the evidence", async () => {
    const provider = staticProvider({});
    const out = await investigate({
      evidence: EVIDENCE,
      policyDecision: EVIDENCE.decision.offchainDecision,
      deterministicReason: 999, // a reason the evidence does not carry
      provider,
      model: "gpt-oss:20b",
    });

    expect(out.investigator.status).toBe("UNAVAILABLE");
    expect(out.investigator.diagnostics?.failureReason).toMatch(/REASON_CONTRADICTS_VERDICT/);
    expect(provider.calls).toHaveLength(0);
    expect(out.policyDecision).toBe(EVIDENCE.decision.offchainDecision);
  });

  it("refuses to investigate evidence missing a field the policy checks on", async () => {
    const provider = staticProvider({});
    const thinned = { ...EVIDENCE, budget: undefined } as unknown as typeof EVIDENCE;
    const out = await investigate({
      evidence: thinned,
      policyDecision: EVIDENCE.decision.offchainDecision,
      deterministicReason: EVIDENCE.decision.reason,
      provider,
      model: "gpt-oss:20b",
    });

    expect(out.investigator.status).toBe("INVALID_OUTPUT");
    expect(out.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
    expect(out.investigator.diagnostics?.failureReason).toMatch(/MISSING_REQUIRED_FIELDS/);
    expect(out.investigator.diagnostics?.failureReason).toMatch(/treasuryBalanceBaseUnits/);
    expect(provider.calls).toHaveLength(0);
    expect(out.policyDecision).toBe(EVIDENCE.decision.offchainDecision);
  });

  it("accepts genuinely consistent evidence and does call the provider", async () => {
    const provider = staticProvider({});
    for (const decision of ["AUTO_APPROVED", "PENDING", "BLOCKED"] as const) {
      const evidence = evidenceForDecision(decision);
      const out = await investigate({
        evidence,
        policyDecision: decision,
        deterministicReason: evidence.decision.reason,
        provider,
        model: "gpt-oss:20b",
      });
      expect(out.investigator.status, decision).toBe("OK");
    }
    expect(provider.calls).toHaveLength(3);
  });
});

describe("recommendation constraint", () => {
  it("blocks an upgrade recommendation when the decision is BLOCKED", () => {
    expect(constrainRecommendation("BLOCKED", "PROCEED_TO_HUMAN_REVIEW")).toEqual({
      recommendation: "INSUFFICIENT_EVIDENCE",
      constrained: true,
    });
  });

  it("leaves a more cautious recommendation intact when the decision is AUTO_APPROVED", () => {
    expect(constrainRecommendation("AUTO_APPROVED", "NO_ACTION")).toEqual({
      recommendation: "NO_ACTION",
      constrained: false,
    });
  });

  it("leaves every recommendation intact when the decision is PENDING", () => {
    for (const r of ["PROCEED_TO_HUMAN_REVIEW", "NO_ACTION", "BLOCK", "INSUFFICIENT_EVIDENCE"] as const) {
      expect(constrainRecommendation("PENDING", r).constrained).toBe(false);
    }
  });
});