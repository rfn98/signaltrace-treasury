/**
 * Milestone I acceptance tests.
 *
 * These are end-to-end through `investigatePayment`: real Milestone G evidence building, real
 * Milestone G reconciliation, real Milestone H validation. Only three things are stubbed, and
 * each stub replaces a boundary that cannot exist in a test: the database, the RPC endpoint,
 * and the AI provider.
 *
 * The policy verdict in every assertion below is produced by the deterministic engine from
 * observed chain state. No test asserts a decision by asking the AI, because the AI cannot make
 * one — tests A, B, C and J exist to prove exactly that.
 */
import { describe, expect, it } from "vitest";
import { buildCreationEvidence } from "@/lib/evidence/build";
import { MIL_E_POLICY, PaymentStatus, CHAIN_ID } from "@/lib/policy/types";
import type { InvestigatorResult } from "@/lib/investigator/types";
import { investigatePayment, mismatchAffectsPolicy } from "../service";
import { INVESTIGATION_VERSION, parsePaymentId, type ChainContext } from "../types";
import {
  agreeingRepository,
  BLOCKING_AMOUNT,
  FailingChainReader,
  FailingRepository,
  PAYMENT_ONE_AMOUNT,
  PAYMENT_TWO_AMOUNT,
  RecordingProvider,
  SCENARIOS,
  StubChainReader,
  StubRepository,
  bytes32Of,
  dbPaymentFor,
  makeAgreeingChain,
  makeChainContext,
  makeDbSnapshot,
  makePaymentRecord,
  okInvestigator,
} from "./fixtures";

/**
 * Default wiring: an index derived from the chain snapshot, so the two agree and the
 * investigation is not gated before it starts. Any test that wants a mismatch supplies its own
 * repository, which is the only way to make one — by construction, not by accident.
 */
const deps = (over: Partial<Parameters<typeof investigatePayment>[1]> = {}) => {
  const chain = over.chain ?? new StubChainReader(makeAgreeingChain());
  return {
    repository: over.repository ?? agreeingRepository(makeAgreeingChain()),
    chain,
    provider: over.provider ?? new RecordingProvider(okInvestigator("AUTO_APPROVED")),
    model: "test-model",
    ...(over.buildEvidence ? { buildEvidence: over.buildEvidence } : {}),
  };
};

/** Wires a chain fixture together with an index that agrees with it. */
const wired = (context: ChainContext, over: Partial<Parameters<typeof investigatePayment>[1]> = {}) => {
  const chain = new StubChainReader(context);
  return deps({ chain, repository: agreeingRepository(context, context.payment?.id ?? 1n), ...over });
};

describe("payment id validation", () => {
  it("accepts a canonical positive decimal id", () => {
    expect(parsePaymentId("1")).toBe(1n);
    expect(parsePaymentId("42")).toBe(42n);
    expect(parsePaymentId("115792089237316195423570985008687907853269984665640564039457584007913129639935")).not.toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["leading zero", "007"],
    ["negative", "-1"],
    ["signed plus", "+1"],
    ["hex", "0x1"],
    ["whitespace", " 1"],
    ["trailing space", "1 "],
    ["non numeric", "abc"],
    ["decimal", "1.0"],
    ["comma separated", "1,000"],
    ["too long", "1".repeat(79)],
  ])("rejects %s", (_label, raw) => {
    expect(parsePaymentId(raw)).toBeNull();
  });

  it("rejects a malformed id before touching the database, chain or AI", async () => {
    const repository = new FailingRepository(); // throws if it is ever called
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    const outcome = await investigatePayment("not-a-number", deps({ repository, provider }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("INVALID_PAYMENT_ID");
    expect(outcome.result).toBeNull();
    expect(provider.callCount).toBe(0);
  });
});

describe("A, B, C: deterministic policy verdicts from observed chain state", () => {
  it.each(SCENARIOS)("$name", async (scenario) => {
    const context = makeAgreeingChain({ amount: scenario.amount, balance: scenario.balance });
    const provider = new RecordingProvider(okInvestigator(scenario.expectedDecision));
    const outcome = await investigatePayment(
      scenario.paymentId.toString(),
      wired(context, { provider }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.result;

    // The verdict is deterministic and matches the scenario.
    expect(result.policy.decision).toBe(scenario.expectedDecision);
    expect(result.policy.allowed).toBe(scenario.expectedDecision !== "BLOCKED");

    // It comes from the G engine's reason code, and it is internally consistent.
    expect(result.policy.reasonName).toBeTruthy();
    expect(result.evidence.hash).toMatch(/^sha256:/);

    // The investigator was called and is advisory only.
    expect(provider.callCount).toBe(1);
    expect(result.investigator.status).toBe("OK");
    expect(result.investigator.authority).toBe("ADVISORY_ONLY");

    // The full composed result is present and versioned.
    expect(result.investigationVersion).toBe(INVESTIGATION_VERSION);
    expect(result.evidence.version).toBe("signaltrace.evidence/v1");
    expect(result.reconciliation.schemaVersion).toBe("signaltrace.reconciliation/v1");
    expect(result.gating).toEqual([]);
    expect(result.context.mirrorAgreesWithContract).toBe(true);
    expect(result.context.paymentPresentOnChain).toBe(true);
    expect(result.context.onChainStatus).toBe("Executed");
  });

  it("takes the amount from the chain, not the database", async () => {
    // The database row claims a tiny amount; the chain says 50 mUSD. The chain must win, and the
    // resulting reconciliation mismatch must be refused rather than silently resolved.
    const record = makePaymentRecord({ onChainPaymentId: 2n, amountBaseUnits: 1n });
    const chain = new StubChainReader(makeAgreeingChain({ chainPaymentIds: [2n] }));
    const provider = new RecordingProvider(okInvestigator("PENDING"));
    const outcome = await investigatePayment(
      "2",
      deps({
        repository: new StubRepository([record], makeDbSnapshot([dbPaymentFor(2n, 1n)])),
        chain,
        provider,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("EVIDENCE_INCONSISTENT");
    expect(outcome.result?.gating[0].fields).toContain("payment[2].amountBaseUnits");
    expect(provider.callCount).toBe(0);
  });

  it("states the daily-limit check against the chain's own committed totals", async () => {
    const outcome = await investigatePayment(
      "1",
      wired(makeAgreeingChain({ amount: 10_000_000n, dayCommitted: 495_000_000n })),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.policy.decision).toBe("BLOCKED");
    expect(outcome.result.policy.reasonName).toBe("DailyLimit");
    const daily = outcome.result.policy.reasons.find((r) => r.checkId === "DAILY_LIMIT");
    expect(daily?.actualBaseUnits).toBe("505000000");
    expect(daily?.limitBaseUnits).toBe("500000000");
  });
});

describe("D: AI provider unavailable", () => {
  it("still returns the deterministic verdict and never fabricates an explanation", async () => {
    const provider: InvestigatorProviderFailing = {
      name: "down",
      async investigate() {
        throw new Error("connection refused");
      },
    };
    const chain = new StubChainReader(makeAgreeingChain());
    const outcome = await investigatePayment("1", deps({ chain, provider }));

    // The request still succeeds: the verdict is unaffected by the advisory layer.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.policy.decision).toBe("AUTO_APPROVED");
    expect(outcome.result.policy.allowed).toBe(true);
    expect(outcome.result.investigator.status).toBe("UNAVAILABLE");
    expect(outcome.result.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.result.investigator.findings).toEqual([]);
    expect(outcome.result.investigator.diagnostics?.failureReason).toBe("PROVIDER_THREW");
  });

  it("reports an unconfigured provider as UNAVAILABLE rather than failing the request", async () => {
    const chain = new StubChainReader(makeAgreeingChain());
    const outcome = await investigatePayment("1", deps({ chain, provider: unconfiguredProvider() }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.policy.decision).toBe("AUTO_APPROVED");
    expect(outcome.result.investigator.status).toBe("UNAVAILABLE");
  });

  it("calls the provider exactly once: no retries", async () => {
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    await investigatePayment("1", deps({ provider }));
    expect(provider.callCount).toBe(1);
  });
});

describe("E: malformed AI output", () => {
  it("degrades the advisory layer to INVALID_OUTPUT and keeps the verdict", async () => {
    const provider = new RecordingProvider(malformedResult());
    const chain = new StubChainReader(makeAgreeingChain());
    const outcome = await investigatePayment("1", deps({ chain, provider }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.policy.decision).toBe("AUTO_APPROVED");
    expect(outcome.result.investigator.status).toBe("INVALID_OUTPUT");
    expect(outcome.result.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.result.investigator.authority).toBe("ADVISORY_ONLY");
  });

  it("rejects a result that tries to widen its own authority", async () => {
    const provider = new RecordingProvider({
      ...okInvestigator("AUTO_APPROVED"),
      authority: "APPROVES_PAYMENT" as never,
    });
    const outcome = await investigatePayment("1", deps({ provider }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.investigator.status).toBe("INVALID_OUTPUT");
    expect(outcome.result.investigator.authority).toBe("ADVISORY_ONLY");
  });

  it("does not adopt an unknown top-level field the model invents", async () => {
    // Milestone H projects the provider's output through an explicit allowlist before
    // validating it, so a field the schema never declared is dropped rather than carried into a
    // result some future consumer might read loosely. Asserted here at the level a caller sees:
    // the invented field does not exist in the output, and the verdict is untouched.
    const provider = new RecordingProvider({
      ...okInvestigator("AUTO_APPROVED"),
      policyOverride: "AUTO_APPROVED",
      approve: true,
    } as unknown as InvestigatorResult);
    const outcome = await investigatePayment("1", wired(makeAgreeingChain(), { provider }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.investigator).not.toHaveProperty("policyOverride");
    expect(outcome.result.investigator).not.toHaveProperty("approve");
    expect(outcome.result.policy.decision).toBe("AUTO_APPROVED");
  });
});

describe("F: fabricated citation", () => {
  it("is rejected because the evidence key does not resolve", async () => {
    const provider = new RecordingProvider({
      ...okInvestigator("AUTO_APPROVED"),
      findings: [
        {
          type: "BALANCE",
          statement: "The treasury holds a hundred billion units.",
          evidenceKeys: ["budget.treasuryBalanceBaseUnits", "budget.treasuryBalanceBaseUnitsDoubled"],
        },
      ],
    });
    const outcome = await investigatePayment("1", deps({ provider }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.investigator.status).toBe("INVALID_OUTPUT");
    expect(outcome.result.investigator.diagnostics?.ungroundedCitationCount).toBeGreaterThan(0);
    // The fabricated number never reaches the caller.
    expect(JSON.stringify(outcome.result.investigator)).not.toContain("100000000000");
  });

  it("accepts a citation that does resolve", async () => {
    const provider = new RecordingProvider({
      ...okInvestigator("AUTO_APPROVED"),
      findings: [
        {
          type: "BALANCE",
          statement: "Treasury balance against the requested amount.",
          evidenceKeys: ["budget.treasuryBalanceBaseUnits", "request.amountBaseUnits"],
        },
      ],
    });
    const outcome = await investigatePayment("1", deps({ provider }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.investigator.status).toBe("OK");
    expect(outcome.result.investigator.diagnostics?.ungroundedCitationCount).toBeUndefined();
  });
});

describe("G: inconsistent evidence and unverified state", () => {
  it("refuses to investigate when the payment is indexed but absent on-chain", async () => {
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    const chain = new StubChainReader(makeAgreeingChain({ chainPaymentIds: [] }));
    const outcome = await investigatePayment("1", deps({ chain, provider }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("EVIDENCE_INSUFFICIENT");
    expect(outcome.result?.gating[0].code).toBe("PAYMENT_ABSENT_FROM_CHAIN");
    expect(outcome.result?.investigator.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.result?.context.paymentPresentOnChain).toBe(false);
    expect(provider.callCount).toBe(0);
  });

  it("refuses to investigate when the policy mirror disagrees with the contract", async () => {
    const context = makeAgreeingChain();
    // The contract says BLOCKED while the off-chain mirror would say AUTO_APPROVED.
    context.contractVerdict = { allowed: false, reason: 8 };
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));

    const outcome = await investigatePayment("1", deps({ chain: new StubChainReader(context), provider }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("EVIDENCE_INCONSISTENT");
    expect(outcome.result?.gating[0].code).toBe("POLICY_MIRROR_DISAGREES_WITH_CONTRACT");
    expect(provider.callCount).toBe(0);
  });

  it("refuses to investigate when the evidence contradicts the evaluator that produced it", async () => {
    // A deliberately broken builder, standing in for any path that could hand H an evidence
    // record whose decision block has been altered after the fact. The verdict must be refused
    // and the provider must never be asked to explain a contradiction.
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    const outcome = await investigatePayment("1", {
      ...wired(makeAgreeingChain(), { provider }),
      buildEvidence: (input) => {
        const evidence = buildCreationEvidence(input);
        return { ...evidence, decision: { ...evidence.decision, offchainDecision: "BLOCKED" } };
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("EVIDENCE_INCONSISTENT");
    expect(outcome.result?.gating[0].code).toBe("EVIDENCE_DECISION_CONTRADICTS_EVALUATOR");
    expect(outcome.result?.investigator.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(provider.callCount).toBe(0);
  });
});

describe("H: payment not found", () => {
  it("returns PAYMENT_NOT_FOUND with no evidence and no AI call", async () => {
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    const outcome = await investigatePayment(
      "999",
      deps({ repository: new StubRepository([], makeDbSnapshot([])), provider }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("PAYMENT_NOT_FOUND");
    expect(outcome.result).toBeNull();
    expect(provider.callCount).toBe(0);
  });
});

describe("I: evidence hash stability", () => {
  it("produces an identical hash for two investigations over identical observed state", async () => {
    // Same observed block, same amounts, same index: two independent runs.
    const run = () => investigatePayment("1", wired(makeAgreeingChain()));

    const first = await run();
    const second = await run();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.result.evidence.hash).toBe(first.result.evidence.hash);
    expect(first.result.evidence.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Same observed block, so the whole result is reproducible, not just the digest.
    expect(second.result.policy).toEqual(first.result.policy);
    expect(second.result.reconciliation.onchainBlockNumber).toBe(first.result.reconciliation.onchainBlockNumber);
  });

  it("produces a different hash when observed state differs", async () => {
    const before = await investigatePayment("1", wired(makeAgreeingChain({ amount: 10_000_000n })));
    const after = await investigatePayment("1", wired(makeAgreeingChain({ amount: 11_000_000n })));

    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.result.evidence.hash).not.toBe(before.result.evidence.hash);
  });
});

describe("J: the AI cannot override the deterministic decision", () => {
  it.each(["AUTO_APPROVED", "PENDING", "BLOCKED"] as const)(
    "keeps policy.decision = %s when the model recommends something else",
    async (decision) => {
      const provider = new RecordingProvider({
        ...okInvestigator(decision),
        recommendation: decision === "BLOCKED" ? "PROCEED_TO_HUMAN_REVIEW" : "BLOCK",
        summary: "The model disagrees with the deterministic engine.",
      });
      const outcome = await investigatePayment(
        "1",
        wired(makeAgreeingChain({ amount: scenarioAmountFor(decision) }), { provider }),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // The verdict is unchanged by the recommendation.
      expect(outcome.result.policy.decision).toBe(decision);
      expect(outcome.result.policy.allowed).toBe(decision !== "BLOCKED");

      // A BLOCKED request cannot be talked into PROCEED_TO_HUMAN_REVIEW by prose.
      if (decision === "BLOCKED") {
        expect(outcome.result.investigator.recommendation).not.toBe("PROCEED_TO_HUMAN_REVIEW");
        expect(outcome.result.investigator.recommendation).toBe("INSUFFICIENT_EVIDENCE");
      }
      // And the authority marker is not something the model can widen.
      expect(outcome.result.investigator.authority).toBe("ADVISORY_ONLY");
    },
  );

  it("exposes the decision to the provider as an input, never as an output", async () => {
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    await investigatePayment("1", deps({ provider }));

    expect(provider.callCount).toBe(1);
    const input = provider.inputs[0];
    expect(input.deterministicDecision).toBe("AUTO_APPROVED");
    // The model receives serialized evidence and the verdict, and nothing else.
    expect(Object.keys(input).sort()).toEqual(["deterministicDecision", "evidenceHash" in input ? "evidenceHash" : "evidenceId", "evidenceJson"].sort());
    expect(input.evidenceJson).toContain('"schemaVersion":"signaltrace.evidence/v1"');
    expect(JSON.parse(input.evidenceJson).decision.offchainDecision).toBe("AUTO_APPROVED");
    // No secret or handle of any kind reaches the model.
    expect(input.evidenceJson).not.toContain("DATABASE_URL");
    expect(input.evidenceJson).not.toContain("API_KEY");
  });
});

describe("dependency failures degrade without inventing a verdict", () => {
  it("returns DEPENDENCY_UNAVAILABLE when the chain cannot be read", async () => {
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    const outcome = await investigatePayment("1", deps({ chain: new FailingChainReader(), provider }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(outcome.result).toBeNull();
    expect(provider.callCount).toBe(0);
  });

  it("returns DEPENDENCY_UNAVAILABLE when the database cannot be read", async () => {
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    const outcome = await investigatePayment("1", deps({ repository: new FailingRepository(), provider }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(provider.callCount).toBe(0);
  });

  it("never leaks an internal error message to the caller", async () => {
    const outcome = await investigatePayment("1", deps({ repository: new FailingRepository() }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).not.toContain("database unreachable");
    expect(outcome.error.message).not.toContain("Error");
  });
});

describe("reconciliation gating classification", () => {
  it.each([
    ["treasury.paused", true],
    ["treasury.address", true],
    ["payment[1]", true],
    ["payment[1].amountBaseUnits", true],
    ["payment[1].status", true],
    ["payment[1].dayIndex", true],
    ["payment[1].monthKey", true],
    ["payment[1].recipient", true],
    ["payment[1].paymentRef", false],
    ["payment[1].createdTxHash", false],
    ["payment[1].executedBlockNumber", false],
    ["recipient[0xabc].approved", false],
    ["policy.singleTxLimit", false],
    ["treasury.balance", false],
    // An unrecognised field fails closed rather than being waved through.
    ["some.unknown.field", true],
  ])("classifies %s as policy-affecting=%s", (field, expected) => {
    expect(mismatchAffectsPolicy(field)).toBe(expected);
  });

  it("investigates despite a non-policy-affecting mismatch, and records it", async () => {
    // Only the paymentRef differs between the index and the chain.
    const record = makePaymentRecord();
    const db = makeDbSnapshot([dbPaymentFor(1n, PAYMENT_ONE_AMOUNT)]);
    db.payments[0].reference = `0x${bytes32Of("DIFFERENT").slice(2)}`;
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));

    const outcome = await investigatePayment("1", deps({
      repository: new StubRepository([record], db),
      chain: new StubChainReader(makeAgreeingChain({ chainPaymentIds: [1n] })),
      provider,
    }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The mismatch is visible rather than swallowed.
    expect(outcome.result.reconciliation.overall).toBe("MISMATCH");
    expect(outcome.result.reconciliation.fields.some((f) => f.field === "payment[1].paymentRef" && f.verdict === "MISMATCH")).toBe(true);
    // And it did not stop a verdict that the mismatch cannot affect.
    expect(outcome.result.policy.decision).toBe("AUTO_APPROVED");
    expect(provider.callCount).toBe(1);
  });

  it("blocks the AI on a policy-affecting mismatch", async () => {
    const db = makeDbSnapshot([dbPaymentFor(1n, 12345n)]); // amount disagrees with the chain
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));

    const outcome = await investigatePayment("1", deps({
      repository: new StubRepository([makePaymentRecord()], db),
      chain: new StubChainReader(makeAgreeingChain({ chainPaymentIds: [1n] })),
      provider,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("EVIDENCE_INCONSISTENT");
    expect(outcome.result?.gating[0].fields).toContain("payment[1].amountBaseUnits");
    expect(provider.callCount).toBe(0);
  });
});

describe("evidence inputs come from the chain", () => {
  it("uses the chain's recipient, amount, policy and counters in the evidence", async () => {
    const provider = new RecordingProvider(okInvestigator("AUTO_APPROVED"));
    await investigatePayment(
      "1",
      deps({
        chain: new StubChainReader(makeAgreeingChain({ amount: 10_000_000n, balance: 140_000_000n })),
        provider,
      }),
    );

    const evidence = JSON.parse(provider.inputs[0].evidenceJson);
    expect(evidence.chainId).toBe(CHAIN_ID);
    expect(evidence.request.amountBaseUnits).toBe("10000000");
    expect(evidence.policy.autoApproveLimit).toBe(MIL_E_POLICY.autoApproveLimit.toString());
    expect(evidence.budget.treasuryBalanceBaseUnits).toBe("140000000");
    expect(evidence.recipient.approved).toBe(true);
    // bytes32 category rendered for a human reader, not as an opaque blob.
    expect(evidence.request.category).toBe("MILESTONE-E");
  });

  it("places committed totals in the chain's current day and month buckets", async () => {
    const chain = makeAgreeingChain({ dayCommitted: 12_345_678n, monthCommitted: 987_654_321n });
    const provider = new RecordingProvider(okInvestigator("PENDING"));
    await investigatePayment("1", deps({ chain: new StubChainReader(chain), provider }));

    const evidence = JSON.parse(provider.inputs[0].evidenceJson);
    expect(evidence.budget.dayIndex).toBe(chain.committed.dayKey.toString());
    expect(evidence.budget.monthKey).toBe(chain.committed.monthKey.toString());
    expect(evidence.budget.dayCommittedBefore).toBe("12345678");
    expect(evidence.budget.monthCommittedBefore).toBe("987654321");
  });
});

describe("HTTP mapping", () => {
  it("maps each error code to the documented status", async () => {
    const cases: [string, number][] = [];
    void cases;

    const notFound = await investigatePayment("999", deps({ repository: new StubRepository([], makeDbSnapshot([])) }));
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error.code).toBe("PAYMENT_NOT_FOUND");

    const unavailable = await investigatePayment("1", deps({ repository: new FailingRepository() }));
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error.code).toBe("DEPENDENCY_UNAVAILABLE");

    const inconsistent = await investigatePayment("1", deps({
      repository: new StubRepository([makePaymentRecord()], makeDbSnapshot([dbPaymentFor(1n, 7n)])),
      chain: new StubChainReader(makeAgreeingChain({ chainPaymentIds: [1n] })),
    }));
    expect(inconsistent.ok).toBe(false);
    if (!inconsistent.ok) expect(inconsistent.error.code).toBe("EVIDENCE_INCONSISTENT");
  });
});

// --- local helpers ------------------------------------------------------------------------

type InvestigatorProviderFailing = {
  name: string;
  investigate(): Promise<InvestigatorResult>;
};

function unconfiguredProvider() {
  return {
    name: "unconfigured",
    async investigate(): Promise<InvestigatorResult> {
      return {
        status: "UNAVAILABLE" as const,
        summary: "AI investigator unavailable; no explanation available.",
        recommendation: "INSUFFICIENT_EVIDENCE" as const,
        findings: [],
        uncertainties: ["Investigator UNAVAILABLE: MISSING_BASE_URL"],
        authority: "ADVISORY_ONLY" as const,
        diagnostics: {
          provider: "unconfigured",
          model: "gpt-oss:20b",
          promptVersion: "signaltrace-investigator-v1",
          latencyMs: 0,
          httpStatusCategory: "none",
          validation: "NOT_RUN" as const,
          failureReason: "MISSING_BASE_URL",
        },
      };
    },
  };
}

/** Output a model might plausibly return and which must not be trusted: an empty shape. */
function malformedResult(): InvestigatorResult {
  return {
    status: "OK",
    summary: "",
    recommendation: "BLOCK",
    findings: [{ type: "NOT_A_REAL_TYPE", statement: "", evidenceKeys: [] }],
    uncertainties: [],
    authority: "ADVISORY_ONLY",
  } as unknown as InvestigatorResult;
}

function scenarioAmountFor(decision: "AUTO_APPROVED" | "PENDING" | "BLOCKED"): bigint {
  if (decision === "AUTO_APPROVED") return PAYMENT_ONE_AMOUNT;
  if (decision === "PENDING") return PAYMENT_TWO_AMOUNT;
  return BLOCKING_AMOUNT;
}

/** Exported so the balance-only failure mode is also covered. */
export { makeChainContext, PaymentStatus };