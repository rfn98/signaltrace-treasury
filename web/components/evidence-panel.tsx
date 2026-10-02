/**
 * Evidence panel — what the verdict rests on, and where each input came from.
 *
 * Three things are deliberately shown:
 *
 *   1. The evidence hash and the block it was observed at, so the verdict can be re-derived and
 *      compared. A verdict that cannot be checked is an assertion.
 *   2. The per-field source map, copied straight from the investigation. This is the trust order
 *      made visible on the page: seven fields from the chain, one from the database index, each
 *      labelled rather than assumed.
 *   3. Only the checks that FAILED, with their reason codes and the two numbers the contract
 *      compared. The passing checks are not reconstructed — the investigation does not expose
 *      them, and re-running policy evaluation inside a UI would make it a second policy engine.
 */
import type { EvidencePanelModel } from "@/lib/treasury/types";
import { formatAmount, formatBlock, formatTimestamp } from "@/lib/ui/format";
import { FullIdentifier } from "./address-chip";
import { Field, FieldList, Num } from "./primitives";
import { StatusBadge } from "./status-badge";
import styles from "./ui.module.css";

/** Field paths are dotted, so they are indented by depth rather than shown as one flat run. */
function sourceRow(field: string, source: string) {
  return (
    <tr key={field}>
      <td>
        <span className={styles.mono}>{field}</span>
      </td>
      <td>
        {source === "chain" ? (
          <span className={styles.label} style={{ color: "var(--positive-fg)" }}>
            chain
          </span>
        ) : source === "database-index" ? (
          <span className={styles.label} style={{ color: "var(--caution-fg)" }}>
            database index
          </span>
        ) : (
          <span className={styles.dim}>{source}</span>
        )}
      </td>
    </tr>
  );
}

export function EvidencePanel({
  evidence,
  symbol,
  decimals,
}: {
  evidence: EvidencePanelModel;
  symbol: string;
  decimals: number;
}) {
  const entries = Object.entries(evidence.sources);
  const chainCount = entries.filter(([, s]) => s === "chain").length;

  return (
    <section className={styles.card} aria-labelledby="evidence-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="evidence-heading">
          Evidence
        </h2>
        <span className={styles.label}>
          {chainCount} of {entries.length} inputs read from the chain
        </span>
      </div>

      <div className={styles.cardBody}>
        <FieldList>
          <Field label="Hash">
            <span className={styles.mono} style={{ overflowWrap: "anywhere" }}>
              {evidence.hash}
            </span>
          </Field>
          <Field label="Schema">
            <span className={styles.mono}>{evidence.version}</span>
          </Field>
          <Field label="Observed at">
            <Num>block {formatBlock(evidence.observedAtBlockNumber)}</Num>
            <span className={styles.dim}> · {formatTimestamp(evidence.observedAtBlockTimestamp)} UTC</span>
          </Field>
          <Field label="Treasury">
            <FullIdentifier value={evidence.treasuryAddress} />
            <span className={styles.dim}> · chain {evidence.chainId}</span>
          </Field>
          <Field label="Contract agrees">
            {evidence.mirrorAgreesWithContract ? (
              <span className={styles.label} style={{ color: "var(--positive-fg)" }}>
                The off-chain evaluation matched the contract&apos;s own evaluatePayment
              </span>
            ) : (
              <span className={styles.label} style={{ color: "var(--negative-fg)" }}>
                The off-chain evaluation disagreed with the contract
              </span>
            )}
          </Field>
        </FieldList>

        <hr className={styles.divider} />

        <h3 className={styles.sectionTitle}>Where each input came from</h3>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>{entries.map(([field, source]) => sourceRow(field, source))}</tbody>
          </table>
        </div>

        <hr className={styles.divider} />

        <h3 className={styles.sectionTitle}>Failed checks</h3>
        {evidence.checks.length === 0 ? (
          <p className={styles.label}>
            No check failed. The investigation reports only failing checks, and there were none, so no
            check rows are shown rather than a reconstructed pass list.
          </p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Reason</th>
                  <th scope="col" className={styles.numeric}>
                    Limit
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Actual
                  </th>
                </tr>
              </thead>
              <tbody>
                {evidence.checks.map((check) => (
                  <tr key={`${check.code}-${check.checkId ?? "none"}`}>
                    <td>
                      <span>{check.label ?? check.checkId ?? "—"}</span>
                      <div className={styles.dim} style={{ fontSize: 11 }}>
                        <span className={styles.mono}>{check.checkId ?? "contract-level"}</span>
                      </div>
                    </td>
                    <td>
                      <span className={styles.mono}>{check.reasonName}</span>
                    </td>
                    <td className={styles.numeric}>
                      {check.limit ? formatAmount(check.limit, decimals, symbol) : <span className={styles.dim}>—</span>}
                    </td>
                    <td className={styles.numeric}>
                      {check.actual ? formatAmount(check.actual, decimals, symbol) : <span className={styles.dim}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <hr className={styles.divider} />

        <h3 className={styles.sectionTitle}>Presence</h3>
        <FieldList>
          <Field label="On chain">
            {evidence.paymentPresentOnChain ? (
              <StatusBadge
                status={{
                  token: "PRESENT",
                  label: "Present",
                  tone: "positive",
                  meaning: "The contract holds a payment record at this id.",
                }}
              />
            ) : (
              <StatusBadge
                status={{
                  token: "ABSENT",
                  label: "Absent",
                  tone: "neutral",
                  meaning: "No payment record exists at this id, so no lifecycle status is claimed.",
                }}
              />
            )}
          </Field>
        </FieldList>
      </div>
    </section>
  );
}