/**
 * Milestone I — investigation orchestration.
 *
 * Composes Milestones F, G and H into one read path:
 *
 *   PaymentRequest -> observed context -> G evidence -> G policy verdict -> H explanation
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT: the deterministic `policyDecision` is computed
 * here from chain state by the G engine, and is carried into H as an input it may not alter.
 * There is no line in this file that lets a model, a recommendation or a provider status feed
 * back into the verdict. H's own re-validation protects its output; this file's ordering
 * protects the verdict.
 *
 * ORDER OF OPERATIONS, and why it is this order and not another:
 *
 *   1. validate the id      — before any I/O, so malformed input cannot cost a database or RPC call
 *   2. load the DB row      — identity and provenance only; establishes the treasury to read
 *   3. read the chain       — authoritative for everything the verdict depends on
 *   4. reconcile            — Milestone G's own comparison, reused whole
 *   5. gate on mismatches   — a disagreement that changes the verdict stops the investigation
 *   6. build G evidence     — one call to the existing builder; nothing here re-derives policy
 *   7. cross-check the mirror against the contract itself
 *   8. call H               — only now, and never if steps 5 or 7 failed
 *
 * Steps 4-5 and 7 all exist for the same reason: a plausible verdict produced from a stale
 * database row, or from an off-chain mirror that has drifted from Treasury.sol, is worse than
 * no verdict, because it looks like an answer. Every one of them fails closed — by refusing to
 * produce a conclusion rather than by producing a forgiving one.
 */
import {
  buildCreationEvidence,
  type BuildCreationEvidenceInput,
  type Evidence,
} from "@/lib/evidence/build";
import { canonicalJson } from "@/lib/evidence/canonical";
import { evaluateCreation } from "@/lib/policy/evaluate";
import { CHAIN_ID } from "@/lib/policy/types";
import type { InvestigatorProvider, PolicyDecision } from "@/lib/investigator/types";
import { investigate } from "@/lib/investigator/service";
import { reconcile } from "@/lib/reconcile/compare";
import type { FieldComparison, ReconciliationReport } from "@/lib/reconcile/types";
import { decodeBytes32 } from "./chain-state";
import {
  INVESTIGATION_VERSION,
  parsePaymentId,
  type ChainContext,
  type ChainStateReader,
  type InvestigationContext,
  type InvestigationErrorCode,
  type InvestigationGate,
  type InvestigationOutcome,
  type InvestigationPolicyView,
  type InvestigationReason,
  type InvestigationResult,
  type InvestigatorView,
  type PaymentRepository,
} from "./types";

export type InvestigationDeps = {
  repository: PaymentRepository;
  chain: ChainStateReader;
  /** Milestone H's provider seam. Never receives anything but serialized evidence. */
  provider: InvestigatorProvider;
  /** Model name, diagnostics only. */
  model: string;
  /**
   * Milestone G's evidence builder, injectable so the "contradictory evidence" path can be
   * exercised without reaching into G internals. Defaults to G's own builder, which is the
   * only production value; no investigation computes its own policy input mapping.
   */
  buildEvidence?: (input: BuildCreationEvidenceInput) => Evidence;
};

/**
 * Reconciliation fields whose disagreement changes the deterministic verdict.
 *
 * This is a classification of Milestone G's EXISTING verdicts, not a second comparison and not
 * new reconciliation semantics: G decides whether the database and the chain agree, and this
 * decides whether that disagreement matters for the verdict we are about to state.
 *
 * What counts:
 *   - amount, recipient, status, day/month buckets: every one of these is a policy input, and a
 *     stale value would produce a verdict about a different payment than the one on-chain
 *   - a bare `payment[N]`: the row exists on exactly one side, so the payment cannot be
 *     identified with certainty at all
 *   - `treasury.paused` and `treasury.address`: both feed the creation checks directly
 *
 * What deliberately does not count:
 *   - `payment[N].paymentRef`: identity metadata for the reader, not an input to the verdict
 *   - tx hashes and block numbers: Milestone G reports these as UNAVAILABLE because they are not
 *     stored on-chain, so a MISMATCH here would mean something else entirely
 *   - `policy.*`, `recipient[...].approved`, `treasury.balance`, `treasury.lifetime*`: these are
 *     UNAVAILABLE by design because Milestone G deliberately does not cache policy off-chain.
 *     They are not stale data, so they cannot contradict the verdict — and in any case this
 *     module reads all of them from the chain, which is authoritative.
 *
 * A non-policy-affecting mismatch does NOT block the investigation. It is surfaced in
 * `reconciliation`, which travels with the result, so it is recorded rather than swallowed.
 */
const POLICY_AFFECTING_FIELDS: readonly { match: RegExp; affects: boolean; why: string }[] = [
  { match: /^treasury\.paused$/, affects: true, why: "input to the paused check" },
  { match: /^treasury\.address$/, affects: true, why: "a mismatch means a different treasury" },
  { match: /^payment\[\d+\]$/, affects: true, why: "the payment exists on only one side" },
  {
    match: /^payment\[\d+\]\.(amountBaseUnits|status|dayIndex|monthKey|recipient)$/,
    affects: true,
    why: "policy input read from chain; a stale cache value would decide a different payment",
  },
  {
    match: /^payment\[\d+\]\.(paymentRef|createdTxHash|createdBlockNumber|executedTxHash|executedBlockNumber)$/,
    affects: false,
    why: "provenance metadata, not a policy input",
  },
  { match: /^recipient\[.*\]\.approved$/, affects: false, why: "not cached off-chain; read from chain" },
  { match: /^policy\./, affects: false, why: "not cached off-chain; read from chain" },
  { match: /^treasury\.(asset|assetDecimals|balance|lifetimeReserved|lifetimeSpent)$/, affects: false, why: "chain-only by design" },
];

/** True when a MISMATCH on `field` would change the verdict we are about to state. */
export function mismatchAffectsPolicy(field: string): boolean {
  const entry = POLICY_AFFECTING_FIELDS.find((f) => f.match.test(field));
  // An unrecognised field is treated as policy-affecting: refusing to investigate on a
  // comparison this module does not understand is the safe direction, since the alternative
  // is stating a verdict with an unknown problem outstanding.
  return entry ? entry.affects : true;
}

/** The failed checks behind the verdict, projected out of G evidence rather than recomputed. */
function reasonsOf(evidence: Evidence): InvestigationReason[] {
  return evidence.checks
    .filter((c) => c.outcome === "FAIL" && c.reason !== undefined)
    .map((c) => ({
      code: c.reason as number,
      name: evidence.decision.reasonName,
      checkId: c.id,
      label: c.label,
      limitBaseUnits: c.limitBaseUnits,
      actualBaseUnits: c.actualBaseUnits,
    }));
}

function policyView(evidence: Evidence): InvestigationPolicyView {
  return {
    decision: evidence.decision.offchainDecision,
    allowed: evidence.decision.allowed,
    reasonCode: evidence.decision.reason,
    reasonName: evidence.decision.reasonName,
    reasons: reasonsOf(evidence),
    authorityNote: evidence.decision.authorityNote,
  };
}

function evidenceView(evidence: Evidence): InvestigationResult["evidence"] {
  return {
    hash: evidence.integrityHash,
    version: evidence.schemaVersion,
    chainId: evidence.chainId,
    treasuryAddress: evidence.treasuryAddress,
    observedAtBlockNumber: evidence.observedAtBlockNumber,
    observedAtBlockTimestamp: evidence.observedAtBlockTimestamp,
  };
}

function contextView(chain: ChainContext, mirrorAgrees: boolean): InvestigationContext {
  const statusNames = [
    "None",
    "Pending",
    "AutoApproved",
    "Approved",
    "Rejected",
    "Executed",
    "Blocked",
  ] as const;
  return {
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
    onChainStatus: chain.payment ? (statusNames[chain.payment.status] ?? "None") : "None",
    mirrorAgreesWithContract: mirrorAgrees,
    paymentPresentOnChain: chain.payment !== null,
  };
}

/**
 * An advisory result that reports the AI was deliberately not called.
 *
 * `INSUFFICIENT_EVIDENCE` is not something a provider can return, so it is built here rather
 * than taken from one. It is the honest answer: the preconditions for an explanation failed, and
 * "we did not ask" is materially different from "the model found nothing".
 */
function notInvestigated(gates: InvestigationGate[]): InvestigatorView {
  const summary =
    "The advisory layer was not invoked: the observed evidence did not satisfy the " +
    "preconditions for a trustworthy explanation. See `gating` for the specific reasons.";
  return {
    status: "INSUFFICIENT_EVIDENCE",
    summary,
    recommendation: "INSUFFICIENT_EVIDENCE",
    findings: [],
    uncertainties: gates.map((g) => `${g.code}: ${g.detail}`),
    authority: "ADVISORY_ONLY",
    diagnostics: {
      provider: "not-invoked",
      model: "",
      promptVersion: "",
      latencyMs: 0,
      httpStatusCategory: "not-run",
      validation: "NOT_RUN",
      failureReason: gates.map((g) => g.code).join(","),
    },
  };
}

function gated(
  code: InvestigationErrorCode,
  message: string,
  gates: InvestigationGate[],
  partial: {
    evidence?: InvestigationResult["evidence"];
    policy?: InvestigationPolicyView;
    reconciliation?: ReconciliationReport;
    context?: InvestigationContext;
    reference?: string;
    paymentId: string;
  },
): InvestigationOutcome {
  return {
    ok: false,
    error: { code, message },
    result: {
      investigationVersion: INVESTIGATION_VERSION,
      request: { paymentId: partial.paymentId, reference: partial.reference ?? "" },
      policy:
        partial.policy ??
        ({
          decision: "BLOCKED",
          allowed: false,
          reasonCode: 0,
          reasonName: "None",
          reasons: [],
          authorityNote:
            "Not evaluated: the investigation was gated before a verdict could be stated.",
        } as InvestigationPolicyView),
      evidence: partial.evidence ?? {
        hash: "",
        version: "signaltrace.evidence/v1",
        chainId: CHAIN_ID,
        treasuryAddress: "",
        observedAtBlockNumber: "",
        observedAtBlockTimestamp: "",
      },
      investigator: notInvestigated(gates),
      reconciliation:
        partial.reconciliation ??
        ({
          schemaVersion: "signaltrace.reconciliation/v1",
          chainId: CHAIN_ID,
          treasuryAddress: "",
          onchainBlockNumber: "",
          onchainBlockTimestamp: "",
          summary: { match: 0, mismatch: 0, unavailable: 0 },
          fields: [],
          overall: "UNAVAILABLE",
        } as unknown as ReconciliationReport),
      context:
        partial.context ??
        ({
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
          onChainStatus: "None",
          mirrorAgreesWithContract: false,
          paymentPresentOnChain: false,
        } as InvestigationContext),
      gating: gates,
    },
  };
}

/**
 * Investigates one payment and returns a stable result.
 *
 * NEVER writes anything, and never throws: every dependency failure resolves to an outcome the
 * route can turn into a status code. `policy.decision` is authoritative in every outcome that
 * carries one, and no field of `investigator` can influence it.
 */
export async function investigatePayment(
  rawPaymentId: string,
  deps: InvestigationDeps,
): Promise<InvestigationOutcome> {
  // 1. Validate before any I/O. A malformed id must not cost a database or RPC call.
  const paymentId = parsePaymentId(rawPaymentId);
  if (paymentId === null) {
    return {
      ok: false,
      error: { code: "INVALID_PAYMENT_ID", message: "paymentId must be a positive decimal integer" },
      result: null,
    };
  }
  const paymentIdText = paymentId.toString(10);

  // 2. Database: identity and provenance only. Never a policy input.
  let record;
  let report: ReconciliationReport | null = null;
  try {
    record = await deps.repository.findPayment(paymentId);
    if (!record) {
      return {
        ok: false,
        error: { code: "PAYMENT_NOT_FOUND", message: `no indexed payment with id ${paymentIdText}` },
        result: null,
      };
    }
  } catch {
    return {
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "the payment index could not be read" },
      result: null,
    };
  }

  // 3. Chain: authoritative for everything the verdict depends on.
  let chain: ChainContext;
  let db;
  try {
    db = await deps.repository.loadDbSnapshot(record.treasuryAddress);
    if (!db) {
      return {
        ok: false,
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "the treasury index row is missing" },
        result: null,
      };
    }
    chain = await deps.chain.read({
      treasuryAddress: record.treasuryAddress,
      onChainPaymentId: paymentId,
    });
  } catch {
    return {
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "observed chain state could not be read" },
      result: null,
    };
  }

  // 4. Milestone G reconciliation, reused whole. No second comparison is implemented here.
  report = reconcile(chain.snapshot, db);

  const reference = chain.payment ? `0x${(chain.payment.paymentRef ?? record.reference).replace(/^0x/, "")}` : record.reference;

  // 5. The payment must exist on-chain. An index row the chain cannot corroborate cannot be
  //    investigated: there is no observed state to reason about.
  if (!chain.payment) {
    return gated(
      "EVIDENCE_INSUFFICIENT",
      `payment ${paymentIdText} is indexed in the database but not present in the chain snapshot`,
      [
        {
          code: "PAYMENT_ABSENT_FROM_CHAIN",
          detail:
            "the database index contains this payment id but the contract does not expose it; " +
            "no observed state exists to evaluate",
        },
      ],
      { paymentId: paymentIdText, reference: record.reference, reconciliation: report },
    );
  }

  // 5b. Gate on reconciliation. Only MISMATCH gates; UNAVAILABLE is a designed absence, and
  //     a mismatch on a non-policy-affecting field is recorded and carried, not suppressed.
  const blocking: FieldComparison[] = report.fields.filter(
    (f) => f.verdict === "MISMATCH" && mismatchAffectsPolicy(f.field),
  );
  if (blocking.length > 0) {
    return gated(
      "EVIDENCE_INCONSISTENT",
      "database and chain disagree on state the policy verdict depends on",
      [
        {
          code: "POLICY_AFFECTING_RECONCILIATION_MISMATCH",
          detail: blocking.map((f) => `${f.field}: database ${f.offchain ?? "null"} vs chain ${f.onchain ?? "null"}`).join("; "),
          fields: blocking.map((f) => f.field),
        },
      ],
      {
        paymentId: paymentIdText,
        reference,
        reconciliation: report,
        context: contextView(chain, false),
      },
    );
  }

  // 6. Build G evidence. Counters are placed in the CURRENT day/month buckets with the chain's
  //    own committed totals, because spent buckets are written at execution time and cannot be
  //    derived from the payment list. Counters are chain-sourced, never database-sourced.
  const payment = chain.payment;
  const counters = {
    ...chain.snapshot.counters,
    reservedDay: {},
    reservedMonth: {},
    spentDay: { [chain.committed.dayKey.toString(10)]: chain.committed.dayCommitted },
    spentMonth: { [chain.committed.monthKey.toString(10)]: chain.committed.monthCommitted },
  };

  const build = deps.buildEvidence ?? buildCreationEvidence;
  const evidenceInput: BuildCreationEvidenceInput = {
    to: payment.recipient,
    amount: payment.amount,
    policy: chain.snapshot.policy,
    counters,
    recipient: chain.recipient,
    dayKey: chain.committed.dayKey,
    monthKey: chain.committed.monthKey,
    chainId: chain.snapshot.chainId,
    treasuryAddress: chain.snapshot.treasuryAddress,
    category: decodeBytes32(payment.category),
    reference,
    observedAtBlockNumber: chain.snapshot.blockNumber,
    observedAtBlockTimestamp: chain.snapshot.blockTimestamp,
  };
  const evidence = build(evidenceInput);

  // 6b. Cross-check the evidence against the evaluator that produced it.
  //
  //     `buildCreationEvidence` is trusted because it calls G's own `evaluateCreation`, and this
  //     check is what makes that trust verifiable rather than merely asserted: the same
  //     evaluator is run again on the same inputs and must produce the same verdict. It is a
  //     cheap, decisive guard against an evidence record whose `decision` block has been
  //     altered after the fact, which would otherwise let the three-way decision drift away
  //     from the `allowed` flag and reason beside it in the same object.
  const evaluated = evaluateCreation(evidenceInput);
  const evidenceAgrees =
    evaluated.decision === evidence.decision.offchainDecision &&
    evaluated.allowed === evidence.decision.allowed &&
    evaluated.reason === evidence.decision.reason;

  if (!evidenceAgrees) {
    return gated(
      "EVIDENCE_INCONSISTENT",
      "the evidence record disagrees with the deterministic evaluator on the same inputs",
      [
        {
          code: "EVIDENCE_DECISION_CONTRADICTS_EVALUATOR",
          detail:
            `evidence decision=${evidence.decision.offchainDecision} allowed=${evidence.decision.allowed} ` +
            `reason=${evidence.decision.reasonName}; ` +
            `evaluator decision=${evaluated.decision} allowed=${evaluated.allowed} reason=${evaluated.reason}`,
        },
      ],
      {
        paymentId: paymentIdText,
        reference,
        evidence: evidenceView(evidence),
        reconciliation: report,
        context: contextView(chain, false),
      },
    );
  }

  // 7. Cross-check the off-chain mirror against the contract's own verdict. Milestone G mirrors
  //    Treasury.sol; a mirror that has drifted would otherwise produce confident nonsense.
  const mirrorAgrees =
    chain.contractVerdict !== null &&
    evidence.decision.allowed === chain.contractVerdict.allowed &&
    evidence.decision.reason === chain.contractVerdict.reason;

  if (!mirrorAgrees) {
    return gated(
      "EVIDENCE_INCONSISTENT",
      "the off-chain policy mirror disagrees with the contract's own verdict",
      [
        {
          code: "POLICY_MIRROR_DISAGREES_WITH_CONTRACT",
          detail: chain.contractVerdict
            ? `mirror allowed=${evidence.decision.allowed} reason=${evidence.decision.reason}; ` +
              `contract allowed=${chain.contractVerdict.allowed} reason=${chain.contractVerdict.reason}`
            : "the contract verdict could not be obtained for this payment",
        },
      ],
      {
        paymentId: paymentIdText,
        reference,
        evidence: evidenceView(evidence),
        policy: policyView(evidence),
        reconciliation: report,
        context: contextView(chain, false),
      },
    );
  }

  // 8. Advisory layer. Reached only when every precondition above held.
  const policyDecision: PolicyDecision = evidence.decision.offchainDecision;
  const advisory = await investigate({
    evidence,
    policyDecision,
    deterministicReason: evidence.decision.reason,
    provider: deps.provider,
    model: deps.model,
  });

  return {
    ok: true,
    result: {
      investigationVersion: INVESTIGATION_VERSION,
      request: { paymentId: paymentIdText, reference },
      policy: policyView(evidence),
      evidence: evidenceView(evidence),
      investigator: advisory.investigator,
      reconciliation: report,
      context: contextView(chain, true),
      gating: [],
    },
  };
}

/** Re-exported so callers can assert what was actually handed to the model. */
export { canonicalJson };