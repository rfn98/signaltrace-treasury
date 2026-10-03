/**
 * Reconciliation table and settlement timeline.
 *
 * The reconciliation table is Milestone G's output, reproduced rather than recomputed. It shows the
 * index value, the chain value and a verdict per field, which is what makes a MISMATCH actionable
 * instead of merely alarming.
 *
 * `UNAVAILABLE` is rendered distinctly from `MATCH` on purpose. Nineteen of the fields this project
 * reconciles are deliberately not cached off-chain; if "not stored" were styled as agreement, the
 * table would report a clean bill of health for data it never checked. The status mapping in
 * `lib/ui/status` already carries that wording, and it is used verbatim.
 */
import type { DetailPanelModel, ReconciliationPanelModel } from "@/lib/treasury/types";
import { formatBlock, formatIsoDate } from "@/lib/ui/format";
import { AddressChip, HashLink } from "./address-chip";
import { Field, FieldList, Num } from "./primitives";
import { StatusBadge } from "./status-badge";
import styles from "./ui.module.css";

export function ReconciliationTable({ reconciliation }: { reconciliation: ReconciliationPanelModel }) {
  return (
    <section className={styles.card} aria-labelledby="reconciliation-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="reconciliation-heading">
          Index vs chain
        </h2>
        <StatusBadge status={reconciliation.overall} />
      </div>

      <div className={styles.cardBody}>
        <p className={styles.label}>{reconciliation.summary}</p>

        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Database index</th>
                <th scope="col">Chain</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.fields.map((field) => (
                <tr key={field.field}>
                  <td>
                    <span className={styles.mono}>{field.field}</span>
                    {field.note ? (
                      <div className={styles.dim} style={{ fontSize: 11 }}>
                        {field.note}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {field.offchain === null ? (
                      <span className={styles.dim}>not cached</span>
                    ) : (
                      <span className={styles.mono}>{field.offchain}</span>
                    )}
                  </td>
                  <td>
                    {field.onchain === null ? (
                      <span className={styles.dim}>not read</span>
                    ) : (
                      <span className={styles.mono}>{field.onchain}</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={field.verdict} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className={styles.label}>
          Compared at chain block <Num>{formatBlock(reconciliation.onchainBlockNumber)}</Num>.
        </p>
      </div>
    </section>
  );
}

/**
 * Settlement timeline, from the index.
 *
 * Transaction hashes and block numbers are not stored on chain, so every value here comes from the
 * database index and is labelled as such in the panel header. That is a provenance statement, not a
 * hedge: the chain confirms the outcome, the index confirms the transaction.
 */
export function SettlementTimeline({
  settlement,
  explorerBaseUrl,
}: {
  settlement: DetailPanelModel["settlement"];
  explorerBaseUrl: string;
}) {
  return (
    <section className={styles.card} aria-labelledby="settlement-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="settlement-heading">
          Settlement
        </h2>
        <span className={styles.label}>provenance from the database index</span>
      </div>

      <div className={styles.cardBody}>
        <FieldList>
          <Field label="Lifecycle">
            {settlement.lifecycle ? (
              <StatusBadge status={settlement.lifecycle} />
            ) : (
              <span className={styles.dim}>Not on chain</span>
            )}
          </Field>
          <Field label="Requested by">
            <AddressChip address={settlement.requestedBy} explorerBaseUrl={explorerBaseUrl} />
          </Field>
          <Field label="Approved by">
            {settlement.approvedBy ? (
              <AddressChip address={settlement.approvedBy} explorerBaseUrl={explorerBaseUrl} />
            ) : (
              <span className={styles.dim}>
                No human approval — this payment was settled on the engine&apos;s authority
              </span>
            )}
          </Field>
          <Field label="Executed by">
            <AddressChip address={settlement.executedBy} explorerBaseUrl={explorerBaseUrl} />
          </Field>
          <Field label="Created">
            {settlement.createdTxHash ? (
              <>
                <HashLink hash={settlement.createdTxHash} explorerBaseUrl={explorerBaseUrl} />
                <span className={styles.dim}> · block </span>
                <Num>{formatBlock(settlement.createdBlockNumber)}</Num>
              </>
            ) : (
              <span className={styles.dim}>Not indexed</span>
            )}
          </Field>
          <Field label="Approved">
            {settlement.approvedTxHash ? (
              <HashLink hash={settlement.approvedTxHash} explorerBaseUrl={explorerBaseUrl} />
            ) : (
              // States the absence rather than printing a bare null. Matches the neighbouring
              // "Not indexed" / "Not settled" register, and does not re-assert the authority claim
              // the "Approved by" field above already makes.
              <span className={styles.dim}>No approval transaction</span>
            )}
          </Field>
          <Field label="Executed">
            {settlement.executedTxHash ? (
              <>
                <HashLink hash={settlement.executedTxHash} explorerBaseUrl={explorerBaseUrl} />
                <span className={styles.dim}> · block </span>
                <Num>{formatBlock(settlement.executedBlockNumber)}</Num>
              </>
            ) : (
              <span className={styles.dim}>Not settled</span>
            )}
          </Field>
          <Field label="Timestamps">
            {settlement.createdAt || settlement.executedAt ? (
              <span className={styles.label}>
                Created {formatIsoDate(settlement.createdAt)}
                {settlement.executedAt ? ` · executed ${formatIsoDate(settlement.executedAt)}` : ""}
              </span>
            ) : (
              <span className={styles.dim}>Not indexed</span>
            )}
          </Field>
        </FieldList>
      </div>
    </section>
  );
}