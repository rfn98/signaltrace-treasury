/**
 * Milestone J — status presentation.
 *
 * WHY A FILE EXISTS: the same fact is spelled three ways across the codebase. The chain holds a
 * numeric `PaymentStatus`, Prisma holds `AUTO_APPROVED`, and Milestone I reports `Executed`.
 * A UI that renders whichever string it happens to receive would show the same state three
 * different ways and — far worse — make it tempting to "just derive" one from the other.
 *
 * THE RULE THIS FILE ENFORCES, and it is the reason this is presentation code and not a helper:
 *
 *   POLICY DECISION and LIFECYCLE STATUS ARE DIFFERENT FACTS AND ARE NEVER MERGED.
 *
 * Payment 2 is the live proof: the policy engine says `PENDING` today (50 mUSD exceeds the
 * 25 mUSD auto-approve limit) while the chain says `Executed`, because the owner approved it
 * manually and it settled. That divergence is the product's best evidence, not a bug to be
 * smoothed over. So `policyStatus()` and `lifecycleStatus()` are separate functions with
 * separate vocabularies, and there is no function here that takes one and returns the other.
 *
 * Nothing in this module decides anything. It maps a value that was decided elsewhere onto a
 * label and a visual tone. It reads no chain, no database and no model output.
 */

import type { PolicyDecision } from "@/lib/investigator/types";
import type { Verdict } from "@/lib/reconcile/types";

/**
 * Visual tone. Deliberately NOT a boolean and NOT the source of truth: it is applied alongside
 * an always-visible text label, never instead of one, so status never depends on colour alone.
 */
export type Tone = "neutral" | "positive" | "caution" | "negative";

export type StatusDisplay = {
  /** Stable machine token, safe to key on and to assert in tests. */
  token: string;
  /** Human label. Always rendered next to the tone. */
  label: string;
  tone: Tone;
  /** One line explaining what the status MEANS, phrased so it cannot be misread. */
  meaning: string;
};

/** Canonical label for a chain lifecycle status (Solidity `PaymentStatus`). */
export const LIFECYCLE_TOKEN: Record<number, string> = {
  0: "NONE",
  1: "PENDING",
  2: "AUTO_APPROVED",
  3: "APPROVED",
  4: "REJECTED",
  5: "EXECUTED",
  6: "BLOCKED",
};

const LIFECYCLE: Record<string, StatusDisplay> = {
  NONE: {
    token: "NONE",
    label: "None",
    tone: "neutral",
    meaning: "No payment occupies this id on chain.",
  },
  PENDING: {
    token: "PENDING",
    label: "Pending",
    tone: "neutral",
    meaning: "Created and awaiting a human decision. No funds reserved or moved.",
  },
  AUTO_APPROVED: {
    token: "AUTO_APPROVED",
    label: "Auto-approved",
    tone: "positive",
    meaning: "Passed the policy engine inside the auto-approve limit. Not yet settled.",
  },
  APPROVED: {
    token: "APPROVED",
    label: "Approved",
    tone: "caution",
    meaning: "A human authorised settlement. Funds still move only when executed.",
  },
  REJECTED: {
    token: "REJECTED",
    label: "Rejected",
    tone: "negative",
    meaning: "Refused. No funds reserved or moved.",
  },
  EXECUTED: {
    token: "EXECUTED",
    label: "Executed",
    tone: "positive",
    meaning: "Settled on chain. Token has left the treasury — this is the financial authority.",
  },
  BLOCKED: {
    token: "BLOCKED",
    label: "Blocked",
    tone: "negative",
    meaning: "Blocked by a policy check at creation. Nothing can be reserved or moved.",
  },
};

const POLICY: Record<PolicyDecision, StatusDisplay> = {
  AUTO_APPROVED: {
    token: "AUTO_APPROVED",
    label: "Auto-approved",
    tone: "positive",
    meaning: "Within the auto-approve limit: the engine raises no objection to this amount.",
  },
  PENDING: {
    token: "PENDING",
    label: "Requires human approval",
    tone: "caution",
    meaning: "Above the auto-approve limit. The engine requires a human decision before settlement.",
  },
  BLOCKED: {
    token: "BLOCKED",
    label: "Blocked",
    tone: "negative",
    meaning: "A policy check fails, so the contract would refuse this request outright.",
  },
};

const RECONCILIATION: Record<Verdict, StatusDisplay> = {
  MATCH: {
    token: "MATCH",
    label: "Match",
    tone: "positive",
    meaning: "The database index agrees with the chain on this field.",
  },
  MISMATCH: {
    token: "MISMATCH",
    label: "Mismatch",
    tone: "negative",
    meaning: "The index and the chain disagree. Investigate before trusting the index.",
  },
  UNAVAILABLE: {
    token: "UNAVAILABLE",
    label: "Not cached",
    tone: "neutral",
    meaning: "Deliberately not stored off-chain, or not read. Not evidence of a disagreement.",
  },
};

/** Unknown lifecycle input: shown as such rather than guessed at. */
const UNKNOWN_LIFECYCLE: StatusDisplay = {
  token: "UNKNOWN",
  label: "Unknown",
  tone: "neutral",
  meaning: "The chain reported a status this build does not recognise.",
};

/** Unknown policy input: shown as such rather than guessed at. */
const UNKNOWN_POLICY: StatusDisplay = {
  token: "UNKNOWN",
  label: "Unknown",
  tone: "neutral",
  meaning: "No policy decision was returned.",
};

/**
 * Formats the chain's on-chain lifecycle status.
 *
 * Accepts the numeric enum from `PaymentStatus` OR the PascalCase name Milestone I reports in
 * `context.onChainStatus`, because both are produced by real call sites.
 */
export function lifecycleStatus(status: number | string): StatusDisplay {
  const token =
    typeof status === "number" ? LIFECYCLE_TOKEN[status] : LIFECYCLE_TOKEN[pascalToNumeric(status)];
  return (token && LIFECYCLE[token]) || UNKNOWN_LIFECYCLE;
}

/** Formats the deterministic policy engine's verdict. Never derived from a lifecycle status. */
export function policyStatus(decision: PolicyDecision | string | null | undefined): StatusDisplay {
  if (!decision) return UNKNOWN_POLICY;
  return POLICY[decision as PolicyDecision] ?? UNKNOWN_POLICY;
}

/** Formats a Milestone G reconciliation verdict. */
export function reconciliationStatus(verdict: Verdict | string): StatusDisplay {
  return RECONCILIATION[verdict as Verdict] ?? RECONCILIATION.UNAVAILABLE;
}

/**
 * `Executed` -> 5. Mirrors the numeric enum, for the PascalCase form Milestone I reports.
 *
 * Comparison ignores case, spaces and underscores, because Milestone I reports `AutoApproved`
 * while the canonical token is `AUTO_APPROVED`. Matching on the raw string would silently turn a
 * perfectly valid chain status into "Unknown", which is the failure mode this exists to prevent.
 */
function pascalToNumeric(name: string): number {
  const needle = normaliseToken(name);
  for (const [value, token] of Object.entries(LIFECYCLE_TOKEN)) {
    if (normaliseToken(token) === needle) return Number(value);
  }
  return -1;
}

/** Case/separator-insensitive token comparison key. */
function normaliseToken(value: string): string {
  return value.replace(/[\s_]/g, "").toUpperCase();
}

/**
 * Formats the advisory layer's status.
 *
 * `INSUFFICIENT_EVIDENCE` is the one that matters for the demo: it means the investigator was
 * NEVER CALLED because a gate failed, which is categorically different from a provider outage.
 * The `meaning` text says so, because "we refused to ask" and "the model had nothing to add"
 * must never be presented as the same event.
 */
export function investigatorStatus(status: string | null | undefined): StatusDisplay {
  switch (status) {
    case "OK":
      return {
        token: "OK",
        label: "Explanation ready",
        tone: "neutral",
        meaning: "The advisory layer produced a re-validated explanation of the verdict above.",
      };
    case "UNAVAILABLE":
      return {
        token: "UNAVAILABLE",
        label: "No explanation available",
        tone: "neutral",
        meaning: "The advisory provider was unreachable or unconfigured. The verdict is unaffected.",
      };
    case "INVALID_OUTPUT":
      return {
        token: "INVALID_OUTPUT",
        label: "Explanation rejected",
        tone: "caution",
        meaning: "Provider output failed re-validation and was discarded. The verdict is unaffected.",
      };
    case "INSUFFICIENT_EVIDENCE":
      return {
        token: "INSUFFICIENT_EVIDENCE",
        label: "Not investigated",
        tone: "caution",
        meaning:
          "The investigator was deliberately not called: a precondition failed. The deterministic verdict is unaffected.",
      };
    default:
      return {
        token: "UNKNOWN",
        label: "Unknown",
        tone: "neutral",
        meaning: "The advisory layer reported a status this build does not recognise.",
      };
  }
}

/**
 * PERMANENT label for the advisory section.
 *
 * Hardcoded here rather than passed in so it cannot be omitted or overridden by a caller. The
 * requirement is that the boundary is always on screen, not that it is usually on screen.
 */
export const ADVISORY_ONLY_NOTICE =
  "Advisory only — cannot approve, reject, or execute.";

/**
 * Investigates nothing and decides nothing. Present so a reviewer's first question — "can the UI
 * answer 'should this be approved?'" — has a machine-checkable answer: it cannot.
 *
 * Deliberately not exported as a function that returns a status, to avoid creating an API that
 * looks like a decision path. It answers a question about the UI, not about a payment.
 */
export const UI_PERFORMS_NO_DECISIONS = true;

/**
 * Tone for a limit meter, given usage against a limit.
 *
 * `unlimited` exists because a zero limit means UNLIMITED in Treasury.sol — a value the UI must
 * not render as an exhausted bar. Encoded once, here, so no component re-derives it.
 */
export type UsageTone = "unlimited" | "ok" | "warning" | "exceeded";

export function usageTone(used: bigint, limit: bigint): UsageTone {
  if (limit === 0n) return "unlimited";
  if (used > limit) return "exceeded";
  if (used * 10n >= limit * 9n) return "warning";
  return "ok";
}