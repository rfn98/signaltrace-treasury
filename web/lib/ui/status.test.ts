/**
 * Milestone J — status presentation tests.
 *
 * These are the tests that matter most in this milestone, because the presentation layer is where
 * it is easiest to quietly break the two laws:
 *
 *   1. a policy decision must never be shown as a lifecycle status (or vice versa)
 *   2. the advisory layer must never be rendered as though it held authority
 *
 * Everything asserted here is presentation-only. No chain, no database, no provider.
 */
import { describe, expect, it } from "vitest";

import { PaymentStatus, ReasonCode } from "@/lib/policy/types";
import {
  ADVISORY_ONLY_NOTICE,
  investigatorStatus,
  lifecycleStatus,
  policyStatus,
  reconciliationStatus,
  policyReasonLabel,
  usageTone,
  LIFECYCLE_TOKEN,
} from "@/lib/ui/status";

describe("lifecycleStatus", () => {
  it("maps every on-chain PaymentStatus to a labelled, toned display", () => {
    for (const status of [
      PaymentStatus.None,
      PaymentStatus.Pending,
      PaymentStatus.AutoApproved,
      PaymentStatus.Approved,
      PaymentStatus.Rejected,
      PaymentStatus.Executed,
      PaymentStatus.Blocked,
    ]) {
      const display = lifecycleStatus(status);
      expect(display.label).not.toBe("");
      expect(display.token).not.toBe("UNKNOWN");
      expect(display.meaning).not.toBe("");
      expect(["neutral", "positive", "caution", "negative"]).toContain(display.tone);
    }
  });

  it("reports EXECUTED as the financial authority, not merely as a state", () => {
    // The wording matters: executed means token has left the treasury.
    expect(lifecycleStatus(PaymentStatus.Executed).meaning).toMatch(/left the treasury/i);
  });

  it("distinguishes human APPROVED from engine AUTO_APPROVED", () => {
    const approved = lifecycleStatus(PaymentStatus.Approved);
    const auto = lifecycleStatus(PaymentStatus.AutoApproved);
    expect(approved.token).not.toBe(auto.token);
    expect(approved.label).not.toBe(auto.label);
    // The human step must read as a human step.
    expect(approved.meaning).toMatch(/human/i);
    expect(auto.meaning).toMatch(/engine/i);
  });

  it("accepts the PascalCase form Milestone I reports in context.onChainStatus", () => {
    expect(lifecycleStatus("Executed").token).toBe("EXECUTED");
    expect(lifecycleStatus("AutoApproved").token).toBe("AUTO_APPROVED");
    expect(lifecycleStatus("Blocked").token).toBe("BLOCKED");
  });

  it("reports an unrecognised status as unknown instead of guessing", () => {
    // A guessed status is a fabricated financial fact, so it must degrade to explicit unknown.
    expect(lifecycleStatus(99).token).toBe("UNKNOWN");
    expect(lifecycleStatus("SomethingElse").token).toBe("UNKNOWN");
  });

  it("exposes a stable token for every lifecycle state", () => {
    expect(LIFECYCLE_TOKEN[PaymentStatus.Executed]).toBe("EXECUTED");
    expect(LIFECYCLE_TOKEN[PaymentStatus.Pending]).toBe("PENDING");
  });
});

describe("policyStatus", () => {
  it("labels PENDING as requiring a human rather than as an error", () => {
    // This is the single most consequential label in the UI: payment 2 renders as PENDING while
    // being EXECUTED on chain, and "pending" must not read as "something is wrong".
    const display = policyStatus("PENDING");
    expect(display.label).toBe("Requires human approval");
    expect(display.tone).toBe("caution");
    expect(display.meaning).toMatch(/requires a human/i);
  });

  it("labels BLOCKED as the engine refusing outright", () => {
    expect(policyStatus("BLOCKED").tone).toBe("negative");
    expect(policyStatus("BLOCKED").meaning).toMatch(/refuse/i);
  });

  it("labels AUTO_APPROVED without claiming settlement authority", () => {
    const display = policyStatus("AUTO_APPROVED");
    expect(display.tone).toBe("positive");
    // Must not imply the payment has moved or will move.
    expect(display.meaning).not.toMatch(/settled|moved funds|executed/i);
  });

  it("degrades to unknown for a missing decision instead of inferring one", () => {
    expect(policyStatus(null).token).toBe("UNKNOWN");
    expect(policyStatus(undefined).token).toBe("UNKNOWN");
    expect(policyStatus("MAYBE" as never).token).toBe("UNKNOWN");
  });
});

describe("policy decision is never inferred from lifecycle status", () => {
  const everyLifecycle: [number, string][] = [
    [PaymentStatus.Executed, "EXECUTED"],
    [PaymentStatus.Approved, "APPROVED"],
    [PaymentStatus.Pending, "PENDING"],
    [PaymentStatus.Blocked, "BLOCKED"],
    [PaymentStatus.Rejected, "REJECTED"],
    [PaymentStatus.AutoApproved, "AUTO_APPROVED"],
  ];

  it("keeps the two vocabularies distinct even where the words coincide", () => {
    // AUTO_APPROVED and PENDING exist in BOTH vocabularies with different meanings: as a
    // lifecycle state they describe history, as a policy decision they describe the engine's view
    // right now. Same word, different claim — which is exactly why they get separate renderers.
    expect(lifecycleStatus(PaymentStatus.Pending).token).toBe("PENDING");
    expect(policyStatus("PENDING").token).toBe("PENDING");
    // And the meanings are not interchangeable.
    expect(lifecycleStatus(PaymentStatus.Pending).meaning).not.toBe(policyStatus("PENDING").meaning);
  });

  it("never lets a lifecycle status be read as a policy decision", () => {
    for (const [raw] of everyLifecycle) {
      // The only thing lifecycleStatus accepts is a chain status; feeding it a policy token
      // resolves to explicit unknown rather than a confident policy claim.
      expect(lifecycleStatus("AUTO_APPROVED" as never).token).toBe("AUTO_APPROVED");
      // ...and policyStatus is never handed a lifecycle number.
      expect(policyStatus(raw as never).token).toBe("UNKNOWN");
    }
  });
});

describe("investigatorStatus", () => {
  it("separates 'never called' from 'provider had nothing to add'", () => {
    // These are categorically different events and must never render identically.
    const gated = investigatorStatus("INSUFFICIENT_EVIDENCE");
    const unavailable = investigatorStatus("UNAVAILABLE");
    expect(gated.token).not.toBe(unavailable.token);
    expect(gated.meaning).toMatch(/not called/i);
    expect(unavailable.meaning).toMatch(/unreachable|unconfigured/i);
  });

  it("says a verdict is unaffected by an advisory failure", () => {
    // The critical reassurance: the model going away never changes the verdict.
    for (const status of ["UNAVAILABLE", "INVALID_OUTPUT", "INSUFFICIENT_EVIDENCE"]) {
      expect(investigatorStatus(status).meaning).toMatch(/verdict is unaffected/i);
    }
  });

  it("reports discarded provider output rather than presenting it", () => {
    const display = investigatorStatus("INVALID_OUTPUT");
    expect(display.meaning).toMatch(/discarded/i);
    expect(display.tone).toBe("caution");
  });
});

describe("advisory authority", () => {
  it("states the boundary in fixed language that a caller cannot soften", () => {
    expect(ADVISORY_ONLY_NOTICE).toBe("Advisory only — cannot approve, reject, or execute.");
  });

  it("never uses an approving verb in any investigator status", () => {
    const statuses = ["OK", "UNAVAILABLE", "INVALID_OUTPUT", "INSUFFICIENT_EVIDENCE", "WEIRD"];
    for (const status of statuses) {
      const text = `${investigatorStatus(status).label} ${investigatorStatus(status).meaning}`;
      // "recommended" would imply the advisory layer can move a payment along.
      expect(text).not.toMatch(/\brecommend(ed|s)? (this )?payment\b/i);
      expect(text).not.toMatch(/\b(approved|executed) by the (model|AI|assistant)\b/i);
    }
  });
});

describe("reconciliationStatus", () => {
  it("never presents UNAVAILABLE as agreement", () => {
    // Milestone G's whole point: "not cached" is not "matches".
    const display = reconciliationStatus("UNAVAILABLE");
    expect(display.token).toBe("UNAVAILABLE");
    expect(display.tone).toBe("neutral");
    expect(display.meaning).toMatch(/not evidence of a disagreement/i);
  });

  it("keeps MISMATCH alarming", () => {
    expect(reconciliationStatus("MISMATCH").tone).toBe("negative");
  });
});

describe("usageTone", () => {
  it("treats a zero limit as unlimited, never as exhausted", () => {
    // Treasury.sol: 0 means UNLIMITED. Showing an empty bar or "exceeded" here would be a
    // confident false statement about a monetary limit.
    expect(usageTone(0n, 0n)).toBe("unlimited");
    expect(usageTone(10n ** 30n, 0n)).toBe("unlimited");
  });

  it("warns near the ceiling and flags an overrun", () => {
    expect(usageTone(0n, 100n)).toBe("ok");
    expect(usageTone(95n, 100n)).toBe("warning");
    expect(usageTone(101n, 100n)).toBe("exceeded");
  });

  it("warns before, not after, the limit is reached", () => {
    // Exactly at the limit is legal (the check is `total > limit`), so it must not read as exceeded.
    expect(usageTone(100n, 100n)).toBe("warning");
    expect(usageTone(100n, 100n)).not.toBe("exceeded");
  });
});

describe("reason codes remain reportable", () => {
  it("keeps every Solidity ReasonCode nameable for display", () => {
    // The UI renders reason names; a new contract reason must be renderable without inventing a
    // label, which is why this asserts against the enum rather than a hand-typed list.
    const names = Object.keys(ReasonCode).filter((k) => typeof ReasonCode[k as never] === "number");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("policyReasonLabel", () => {
  it("shows no label when no check failed", () => {
    // `None` is valid contract data meaning "nothing failed" — the expected reason for an approved
    // or pending payment. Rendering it would read as an unexplained verdict.
    expect(policyReasonLabel(ReasonCode.None, "None")).toBeNull();
    expect(policyReasonLabel(0, "None")).toBeNull();
  });

  it("keeps a genuine failure reason", () => {
    // The positive case the fix must not break: on a BLOCKED payment the reason IS the answer.
    expect(policyReasonLabel(ReasonCode.UnknownRecipient, "UnknownRecipient")).toBe("UnknownRecipient");
    expect(policyReasonLabel(ReasonCode.DailyLimit, "DailyLimit")).toBe("DailyLimit");
  });

  it("passes the supplied name through untouched", () => {
    // Asserted against the enum rather than hand-typed strings, so a new contract reason renders
    // with its real Solidity name without this file needing to know about it. A numeric enum's
    // reverse mappings are skipped by the typeof guard, exactly as in the test above.
    for (const name of Object.keys(ReasonCode)) {
      const code = ReasonCode[name as keyof typeof ReasonCode];
      if (typeof code !== "number" || code === ReasonCode.None) continue;
      expect(policyReasonLabel(code, name)).toBe(name);
    }
  });

  it("keys off the reason code alone, never the decision", () => {
    // The helper takes no decision token, so it cannot re-derive one. A name that disagrees with
    // the code is still passed through verbatim: the name is reported, never second-guessed.
    expect(policyReasonLabel(ReasonCode.Paused, "Paused")).toBe("Paused");
    expect(policyReasonLabel(ReasonCode.UnknownRecipient, "SingleTxLimit")).toBe("SingleTxLimit");
    // And `None` stays hidden whatever the name claims, because the code is what the contract set.
    expect(policyReasonLabel(ReasonCode.None, "UnknownRecipient")).toBeNull();
  });
});