/**
 * Reconciliation: compare the off-chain database against a read-only on-chain snapshot.
 *
 * The database is a CACHE. It is allowed to lag, and being wrong is not an emergency — but
 * being wrong SILENTLY is. So every field is compared explicitly and classified:
 *
 *   MATCH      — both sides agree.
 *   MISMATCH   — both sides have a value and they differ. Needs a human.
 *   UNAVAILABLE — one side has no value (not read, not present, or the read failed).
 *                 Never silently treated as a match.
 *
 * A reconciliation that reported only "looks fine" would be indistinguishable from one
 * that never checked. The classification is the product here.
 */

export type Verdict = "MATCH" | "MISMATCH" | "UNAVAILABLE";

export type FieldComparison = {
  field: string;
  verdict: Verdict;
  offchain: string | null;
  onchain: string | null;
  note?: string;
};

export type ReconciliationReport = {
  schemaVersion: "signaltrace.reconciliation/v1";
  chainId: number;
  treasuryAddress: string;
  /** Block the on-chain side was read at. Fixes the comparison point in time. */
  onchainBlockNumber: string;
  onchainBlockTimestamp: string;
  summary: {
    match: number;
    mismatch: number;
    unavailable: number;
  };
  fields: FieldComparison[];
  overall: "MATCH" | "MISMATCH";
};

function cmp(
  field: string,
  offchain: string | null | undefined,
  onchain: string | null | undefined,
  note?: string,
): FieldComparison {
  const o = offchain ?? null;
  const c = onchain ?? null;
  let verdict: Verdict;
  if (o === null && c === null) {
    verdict = "UNAVAILABLE";
  } else if (o === null || c === null) {
    verdict = "UNAVAILABLE";
  } else {
    verdict = o === c ? "MATCH" : "MISMATCH";
  }
  return { field, verdict, offchain: o, onchain: c, ...(note ? { note } : {}) };
}

export function summarise(fields: FieldComparison[]): { match: number; mismatch: number; unavailable: number } {
  let match = 0;
  let mismatch = 0;
  let unavailable = 0;
  for (const f of fields) {
    if (f.verdict === "MATCH") match++;
    else if (f.verdict === "MISMATCH") mismatch++;
    else unavailable++;
  }
  return { match, mismatch, unavailable };
}

export { cmp };
