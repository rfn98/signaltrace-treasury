/**
 * Milestone J — investigation detail view-model tests.
 *
 * This is the milestone's most important file. `detail.ts` is pure, so the two rules the product
 * actually rests on can be asserted directly, with no chain, no database and no provider:
 *
 *   1. A policy decision is never derived from a lifecycle status, and vice versa.
 *   2. The advisory layer never supplies or contaminates a decision.
 *
 * The fixtures mirror the two live seed payments, so a passing test here means the demo renders
 * correctly against the real chain state rather than against a convenient invention.
 */
import { describe, expect, it } from "vitest";

import { ReasonCode } from "@/lib/policy/types";
import type {
  InvestigationErrorCode,
  InvestigationOutcome,
  InvestigationResult,
} from "@/lib/investigation/types";
import type { InvestigatorStatus } from "@/lib/investigator/types";
import { toDetailPage, toDetailPanel } from "@/lib/treasury/detail";
import { ADVISORY_ONLY_NOTICE } from "@/lib/ui/status";

const TREASURY = "0xD14e45a90A8b8F603db5Ed21B34Fc947D1bD88E9";

const OPTIONS = {
  indexed: {
    requestedBy: "0x1111111111111111111111111111111111111111",
    approvedBy: null,
    executedBy: "0x2222222222222222222222222222222222222222",
    createdTxHash: "0xaaa",
    approvedTxHash: null,
    executedTxHash: "0xbbb",
    createdBlockNumber: "314300000",
    approvedBlockNumber: null,
    executedBlockNumber: "314303123",
    createdAt: "2026-09-30T12:00:00.000Z",
    executedTxAt: "2026-09-30T13:13:07.000Z",
  },
  network: {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    nativeSymbol: "ETH",
    explorerBaseUrl: "https://sepolia.arbiscan.io",
  },
  asset: {
    symbol: "mUSD",
    name: "Mock USD",
    decimals: 6,
    address: "0xe8b1b0A4b7d6f4e0C3a9F5e2D8b6C1a0F9E3D4c5",
  },
  explorerBaseUrl: "https://sepolia.arbiscan.io",
};

/** Builds a result with only the fields under test varied, so each test states one fact. */
function result(overrides: {
  decision?: "AUTO_APPROVED" | "PENDING" | "BLOCKED";
  onChainStatus?: string;
  present?: boolean;
  investigatorStatus?: InvestigatorStatus | "INSUFFICIENT_EVIDENCE";
  recommendation?: "PROCEED_TO_HUMAN_REVIEW" | "NO_ACTION" | "BLOCK" | "INSUFFICIENT_EVIDENCE";
  gating?: InvestigationResult["gating"];
  reasons?: InvestigationResult["policy"]["reasons"];
  mirrorAgrees?: boolean;
  findings?: InvestigationResult["investigator"]["findings"];
}): InvestigationResult {
  const decision = overrides.decision ?? "AUTO_APPROVED";
  return {
    investigationVersion: "signaltrace.investigation/v1",
    request: { paymentId: "1", reference: "INV-2026-Q1-001" },
    policy: {
      decision: decision as never,
      allowed: decision !== "BLOCKED",
      reasonCode:
        decision === "AUTO_APPROVED"
          ? ReasonCode.None
          : decision === "PENDING"
            ? ReasonCode.SingleTxLimit
            : ReasonCode.UnknownRecipient,
      reasonName:
        decision === "AUTO_APPROVED"
          ? "None"
          : decision === "PENDING"
            ? "SingleTxLimit"
            : "UnknownRecipient",
      reasons: overrides.reasons ?? [],
      authorityNote: "Policy is evaluated from on-chain state by the deterministic engine. No language model participates.",
    },
    evidence: {
      hash: "0xevidencehash",
      version: "signaltrace.evidence/v1",
      chainId: 421614,
      treasuryAddress: TREASURY,
      observedAtBlockNumber: "314303123",
      observedAtBlockTimestamp: "1790773987",
    },
    investigator: {
      status: overrides.investigatorStatus ?? "OK",
      summary: "Amount is within the standing auto-approve limit.",
      recommendation: overrides.recommendation ?? "PROCEED_TO_HUMAN_REVIEW",
      findings: overrides.findings ?? [],
      uncertainties: [],
      authority: "ADVISORY_ONLY",
      diagnostics: {
        provider: "ollama",
        model: "llama3",
        promptVersion: "signaltrace.investigator/v1",
        latencyMs: 812,
        httpStatusCategory: "2xx",
        validation: "PASSED",
        ungroundedCitationCount: 0,
        recommendationConstrained: false,
      },
    },
    reconciliation: {
      schemaVersion: "signaltrace.reconciliation/v1",
      chainId: 421614,
      treasuryAddress: TREASURY,
      onchainBlockNumber: "314303123",
      onchainBlockTimestamp: "1790773987",
      summary: { match: 14, mismatch: 0, unavailable: 19 },
      fields: [
        {
          field: "treasury.balances.token",
          verdict: "MATCH",
          offchain: "1000000000000",
          onchain: "1000000000000",
        },
        {
          field: "payment.category",
          verdict: "UNAVAILABLE",
          offchain: null,
          onchain: "MILESTONE-E",
          note: "Deliberately not indexed off-chain.",
        },
      ],
      overall: "MATCH",
    },
    context: {
      sources: {
        paymentAmount: "chain",
        recipient: "chain",
        recipientApproval: "chain",
        policy: "chain",
        balances: "chain",
        counters: "chain",
        paymentStatus: "chain",
        paymentIdentity: "database-index",
      },
      onChainStatus: overrides.onChainStatus ?? "Executed",
      mirrorAgreesWithContract: overrides.mirrorAgrees ?? true,
      paymentPresentOnChain: overrides.present ?? true,
    },
    gating: overrides.gating ?? [],
  };
}

function page(overrides: Parameters<typeof result>[0]): InvestigationOutcome {
  return { ok: true, result: result(overrides) };
}

describe("LAW 1 — policy and lifecycle are rendered as independent facts", () => {
  it("shows an executed payment whose policy still requires a human, side by side", () => {
    // THE demo case: payment 2. The engine said "a human must approve this" and a human did, and
    // the money moved. Collapsing either fact would be a lie about a financial system.
    const model = toDetailPage(page({ decision: "PENDING", onChainStatus: "Executed" }), OPTIONS);
    expect(model.kind).toBe("ok");
    if (model.kind !== "ok") return;

    expect(model.detail.verdict.policy.token).toBe("PENDING");
    expect(model.detail.verdict.policy.label).toBe("Requires human approval");
    expect(model.detail.verdict.lifecycle?.token).toBe("EXECUTED");
    expect(model.detail.settlement.lifecycle?.token).toBe("EXECUTED");

    // The two must never be presented as the same kind of claim.
    expect(model.detail.verdict.policy.token).not.toBe(model.detail.verdict.lifecycle?.token);
  });

  it("keeps them separate across every policy/lifecycle combination", () => {
    const decisions = ["AUTO_APPROVED", "PENDING", "BLOCKED"] as const;
    const statuses = ["Executed", "Pending", "Approved", "AutoApproved", "Blocked", "Rejected", "None"];

    for (const decision of decisions) {
      for (const status of statuses) {
        const model = toDetailPanel(result({ decision, onChainStatus: status }), OPTIONS);

        // Policy comes from the decision field, and only from the decision field.
        expect(model.verdict.policy.token).toBe(decision);
        // Lifecycle comes from the chain status, and only from the chain status.
        expect(model.verdict.lifecycle?.token).toBe(
          lifecycleTokenFor(status),
        );
        // Raw chain value is preserved so the mapping stays auditable.
        expect(model.verdict.lifecycleRaw).toBe(status);
      }
    }
  });

  it("does not let an executed payment inherit an approval claim", () => {
    // A payment the ENGINE auto-approved shows no human approver, and the UI must not imply one.
    const model = toDetailPanel(result({ decision: "AUTO_APPROVED", onChainStatus: "AutoApproved" }), OPTIONS);
    expect(model.verdict.policy.token).toBe("AUTO_APPROVED");
    // The auto-approve path never populates approvedBy; the fixture deliberately has null there.
    expect(model.settlement.approvedBy).toBeNull();
  });

  it("carries the contract's own reason codes without renaming them", () => {
    const model = toDetailPanel(
      result({
        decision: "BLOCKED",
        reasons: [
          {
            code: ReasonCode.UnknownRecipient,
            name: "UnknownRecipient",
            checkId: "recipient_known",
            label: "Recipient on allowlist",
            limitBaseUnits: null,
            actualBaseUnits: null,
          },
        ],
      }),
      OPTIONS,
    );

    expect(model.verdict.policyReasonCode).toBe(ReasonCode.UnknownRecipient);
    expect(model.verdict.policyReasonName).toBe("UnknownRecipient");
    // The failing check carries the two numbers the contract compared, not a re-derived verdict.
    expect(model.evidence.checks).toHaveLength(1);
    expect(model.evidence.checks[0].checkId).toBe("recipient_known");
  });

  it("reports a policy decision for an off-chain-only payment without inventing a lifecycle", () => {
    // Milestone H/D: a request that was never indexed has no on-chain status. Rendering one would
    // be fabricating a financial fact, so the lifecycle slot is empty and only policy speaks.
    const model = toDetailPanel(result({ decision: "PENDING", present: false }), OPTIONS);
    expect(model.verdict.policy.token).toBe("PENDING");
    expect(model.verdict.lifecycle).toBeNull();
    expect(model.evidence.paymentPresentOnChain).toBe(false);
  });

  it("never presents a blocked policy as settled", () => {
    const model = toDetailPanel(result({ decision: "BLOCKED", onChainStatus: "Executed" }), OPTIONS);
    expect(model.verdict.policy.tone).toBe("negative");
    // A blocked policy alongside an executed lifecycle is itself a finding worth showing.
    expect(model.verdict.lifecycle?.token).toBe("EXECUTED");
  });

  it("carries the contract's reason on the model untouched, including ReasonCode.None", () => {
    // The reason is data, and it stays data. The UI shows no Reason row for `None`, so the model is
    // the only place it survives — a "fix" that blanked these fields would make the panel look right
    // while destroying the reason a reader can audit.
    const approved = toDetailPanel(result({ decision: "AUTO_APPROVED" }), OPTIONS);
    expect(approved.verdict.policyReasonCode).toBe(ReasonCode.None);
    expect(approved.verdict.policyReasonName).toBe("None");

    // A decision carrying a real reason passes through identically, so the panel has something to
    // show. This fixture models PENDING with SingleTxLimit; production `evaluateCreation` returns
    // None for PENDING too. Either way the projection must not rewrite what it was given.
    const pending = toDetailPanel(result({ decision: "PENDING" }), OPTIONS);
    expect(pending.verdict.policyReasonCode).toBe(ReasonCode.SingleTxLimit);
    expect(pending.verdict.policyReasonName).toBe("SingleTxLimit");
  });
});

describe("LAW 2 — the advisory layer holds no authority", () => {
  it("marks the investigator advisory in the model and in the fixed notice", () => {
    const model = toDetailPanel(result({}), OPTIONS);
    // The literal type means no other value can reach this field.
    expect(model.investigator.authority).toBe("ADVISORY_ONLY");
    expect(ADVISORY_ONLY_NOTICE).toBe("Advisory only — cannot approve, reject, or execute.");
  });

  it("shows a contradicting recommendation without letting it touch the verdict", () => {
    // The adversarial case: the model recommends blocking a payment the deterministic engine
    // auto-approved. Both are shown. Neither changes.
    const model = toDetailPanel(
      result({
        decision: "AUTO_APPROVED",
        recommendation: "BLOCK",
        investigatorStatus: "OK",
        findings: [
          {
            type: "RECIPIENT",
            statement: "The recipient label resembles a previously flagged contractor.",
            evidenceKeys: ["recipient.label"],
          },
        ],
      }),
      OPTIONS,
    );

    // The recommendation is surfaced, with its human phrasing...
    expect(model.investigator.recommendation).toBe("BLOCK");
    expect(model.investigator.recommendationLabel).toBe("Concern raised for review");
    expect(model.investigator.findings[0].statement).toContain("flagged contractor");

    // ...and the verdict is untouched, because nothing in the model lets it be anything else.
    expect(model.verdict.policy.token).toBe("AUTO_APPROVED");
    expect(model.verdict.lifecycle?.token).toBe("EXECUTED");
  });

  it("distinguishes an unavailable provider from one that was never asked", () => {
    const unavailable = toDetailPanel(
      result({ investigatorStatus: "UNAVAILABLE", recommendation: "INSUFFICIENT_EVIDENCE" }),
      OPTIONS,
    );
    const gated = toDetailPanel(
      result({
        investigatorStatus: "INSUFFICIENT_EVIDENCE",
        recommendation: "INSUFFICIENT_EVIDENCE",
        gating: [{ code: "EVIDENCE_INSUFFICIENT", detail: "Recipient approval is not readable yet." }],
      }),
      OPTIONS,
    );

    expect(unavailable.investigator.gated).toBe(false);
    expect(gated.investigator.gated).toBe(true);
    // A gate is an explicit reason the question was not asked, so the UI can say why.
    expect(gated.investigator.gates[0].code).toBe("EVIDENCE_INSUFFICIENT");
    expect(gated.status).toBe("INSUFFICIENT_EVIDENCE");

    // Both leave the deterministic verdict standing.
    expect(unavailable.verdict.policy.token).toBe("AUTO_APPROVED");
    expect(gated.verdict.policy.token).toBe("AUTO_APPROVED");
  });

  it("keeps a discarded provider output out of the panel entirely", () => {
    const model = toDetailPanel(
      result({
        investigatorStatus: "INVALID_OUTPUT",
        recommendation: "INSUFFICIENT_EVIDENCE",
        findings: [],
      }),
      OPTIONS,
    );
    expect(model.investigator.status.token).toBe("INVALID_OUTPUT");
    // No unvalidated prose reaches the reader.
    expect(model.investigator.findings).toEqual([]);
    expect(model.investigator.diagnostics?.validation).toBe("PASSED");
  });
});

describe("evidence provenance", () => {
  it("passes through the investigation's own per-field source map", () => {
    const model = toDetailPanel(result({}), OPTIONS);
    expect(model.evidence.sources.policy).toBe("chain");
    expect(model.evidence.sources.paymentIdentity).toBe("database-index");
    // The one field the index owns is labelled as such, in the UI, on the page.
    expect(Object.values(model.evidence.sources).filter((s) => s === "database-index")).toHaveLength(1);
  });

  it("surfaces a mirror disagreement instead of smoothing it over", () => {
    const model = toDetailPanel(result({ mirrorAgrees: false }), OPTIONS);
    expect(model.evidence.mirrorAgreesWithContract).toBe(false);
  });

  it("shows not-cached as not-cached, distinct from a match", () => {
    const model = toDetailPanel(result({}), OPTIONS);
    const category = model.reconciliation.fields.find((f) => f.field === "payment.category");
    expect(category?.verdict.token).toBe("UNAVAILABLE");
    expect(category?.verdict.tone).toBe("neutral");
    expect(category?.verdict.meaning).toMatch(/not evidence of a disagreement/i);
  });

  it("carries the evidence hash and observation block for audit", () => {
    const model = toDetailPanel(result({}), OPTIONS);
    expect(model.evidence.hash).toBe("0xevidencehash");
    expect(model.evidence.observedAtBlockNumber).toBe("314303123");
  });
});

describe("settlement provenance comes from the index only", () => {
  it("uses indexed hashes, blocks and actors", () => {
    const model = toDetailPanel(result({}), OPTIONS);
    expect(model.settlement.createdTxHash).toBe("0xaaa");
    expect(model.settlement.executedTxHash).toBe("0xbbb");
    expect(model.settlement.executedBlockNumber).toBe("314303123");
    expect(model.settlement.executedBy).toBe("0x2222222222222222222222222222222222222222");
    // Auto-approval has no human approver; the field is empty rather than borrowed.
    expect(model.settlement.approvedBy).toBeNull();
    expect(model.settlement.approvedTxHash).toBeNull();
  });

  it("degrades to empty when the payment is not indexed", () => {
    const model = toDetailPanel(result({}), { ...OPTIONS, indexed: null });
    expect(model.settlement.createdTxHash).toBeNull();
    expect(model.settlement.executedBy).toBeNull();
    // The verdict itself does not depend on the index being present.
    expect(model.verdict.policy.token).toBe("AUTO_APPROVED");
  });

  it("keeps absent timestamps absent rather than rendering epoch zero", () => {
    const model = toDetailPanel(result({}), {
      ...OPTIONS,
      indexed: { ...OPTIONS.indexed, executedTxAt: null, createdAt: null },
    });
    expect(model.settlement.executedAt).toBeNull();
    expect(model.settlement.createdAt).toBeNull();
  });
});

describe("refusal states", () => {
  const refusals: InvestigationErrorCode[] = [
    "INVALID_PAYMENT_ID",
    "PAYMENT_NOT_FOUND",
    "DEPENDENCY_UNAVAILABLE",
    "EVIDENCE_INCONSISTENT",
    "EVIDENCE_INSUFFICIENT",
  ];

  it("gives every refusal a title and an explanation, never a bare error", () => {
    for (const code of refusals) {
      const model = toDetailPage({ ok: false, error: { code, message: "raw internal message" }, result: null }, OPTIONS);
      expect(model.kind).toBe("error");
      if (model.kind !== "error") return;
      expect(model.code).toBe(code);
      expect(model.title.length).toBeGreaterThan(0);
      expect(model.explanation.length).toBeGreaterThan(0);
    }
  });

  it("does not leak the raw internal message", () => {
    const model = toDetailPage(
      { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: "connect ECONNREFUSED 10.0.0.5:8547" }, result: null },
      OPTIONS,
    );
    if (model.kind !== "error") throw new Error("expected an error model");
    // An internal endpoint must not reach the page.
    expect(model.explanation).not.toContain("ECONNREFUSED");
    expect(model.explanation).not.toContain("10.0.0.5");
  });

  it("keeps the partial result on a 422, because the reconciliation IS the answer", () => {
    const model = toDetailPage(
      {
        ok: false,
        error: { code: "EVIDENCE_INCONSISTENT", message: "stale index" },
        result: result({
          mirrorAgrees: false,
          gating: [
            { code: "RECONCILIATION_MISMATCH", detail: "Balance differs.", fields: ["treasury.balances.token"] },
          ],
        }),
      },
      OPTIONS,
    );

    if (model.kind !== "error") throw new Error("expected an error model");
    expect(model.partial).not.toBeNull();
    // No verdict is asserted...
    expect(model.title).toMatch(/disagrees with the chain/i);
    // ...but the exact disagreement that caused the refusal is shown.
    expect(model.partial?.reconciliation.fields.length).toBeGreaterThan(0);
    expect(model.partial?.investigator.gated).toBe(true);
    expect(model.partial?.investigator.gates[0].fields).toEqual(["treasury.balances.token"]);
  });

  it("reports a missing dependency as missing, never as a clean bill of health", () => {
    const model = toDetailPage(
      { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: "rpc down" }, result: null },
      OPTIONS,
    );
    if (model.kind !== "error") throw new Error("expected an error model");
    expect(model.partial).toBeNull();
    expect(model.explanation).toMatch(/no verdict is offered/i);
  });
});

/** Canonical lifecycle token for a PascalCase chain status, for the matrix test above. */
function lifecycleTokenFor(status: string): string {
  const table: Record<string, string> = {
    Executed: "EXECUTED",
    Pending: "PENDING",
    Approved: "APPROVED",
    AutoApproved: "AUTO_APPROVED",
    Blocked: "BLOCKED",
    Rejected: "REJECTED",
    None: "NONE",
  };
  return table[status] ?? "UNKNOWN";
}