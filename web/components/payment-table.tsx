/**
 * Payment requests table.
 *
 * The important choice here is that there is ONE status column, showing the chain's lifecycle
 * status, and that it is labelled as such. This list deliberately does NOT show a policy verdict
 * column: evaluating a payment's policy at list time would mean running the policy engine over
 * every row, for no benefit, and the detail page already reports it authoritatively for one payment
 * with full evidence. Showing an unauditable verdict in a summary table is exactly the shortcut this
 * product exists to avoid.
 *
 * The `indexed` flag is rendered rather than hidden. A payment visible on chain with no indexed row
 * is real, and the UI's job is to say so instead of quietly presenting a half-populated row as
 * complete.
 *
 * On narrow screens the table becomes a stacked card per payment rather than scrolling sideways,
 * because a horizontally scrolling financial table hides the rightmost column — which here is the
 * status, the one column that must never be the one you cannot see.
 */
import Link from "next/link";

import type { PaymentList, PaymentRow } from "@/lib/treasury/types";
import { formatAmount, formatBlock } from "@/lib/ui/format";
import { AddressChip, HashLink } from "./address-chip";
import { EmptyState, Num } from "./primitives";
import { StatusBadge } from "./status-badge";
import styles from "./ui.module.css";

function Amount({ row, list }: { row: PaymentRow; list: PaymentList }) {
  return (
    <Num>
      <strong style={{ color: "var(--text)" }}>
        {formatAmount(row.amountBaseUnits, list.asset.decimals, list.asset.symbol)}
      </strong>
    </Num>
  );
}

export function PaymentTable({ list }: { list: PaymentList }) {
  if (list.rows.length === 0) {
    return (
      <EmptyState title="No payments on chain">
        The treasury contract has recorded no payment requests at or below the current id. This is the
        chain&apos;s own count, not the index&apos;s.
      </EmptyState>
    );
  }

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className="sr-only">
          Payment requests recorded by the treasury contract, with their on-chain status and indexed
          transaction provenance.
        </caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Reference</th>
            <th scope="col">Recipient</th>
            <th scope="col" className={styles.numeric}>
              Amount
            </th>
            <th scope="col">Category</th>
            <th scope="col">On-chain status</th>
            <th scope="col">Settlement</th>
            <th scope="col">
              <span className="sr-only">Open investigation</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.rows.map((row) => (
            <tr key={row.paymentId}>
              <td data-label="ID">
                <Num>{row.paymentId}</Num>
              </td>
              <td data-label="Reference">
                <span className={styles.mono} title={row.reference}>
                  {row.reference}
                </span>
                <div className={styles.dim} style={{ fontSize: 11 }}>
                  {row.monthLabel}
                </div>
              </td>
              <td data-label="Recipient">
                <AddressChip address={row.recipient} explorerBaseUrl={list.explorerBaseUrl} />
                <div className={styles.dim} style={{ fontSize: 11 }}>
                  {row.recipientApproved ? "On allowlist" : "Not on allowlist"} · {row.recipientCategory}
                </div>
              </td>
              <td data-label="Amount" className={styles.numeric}>
                <Amount row={row} list={list} />
              </td>
              <td data-label="Category">
                <span className={styles.mono}>{row.category}</span>
              </td>
              <td data-label="On-chain status">
                <StatusBadge status={row.lifecycle} />
              </td>
              <td data-label="Settlement">
                {row.executedTxHash ? (
                  <>
                    <HashLink hash={row.executedTxHash} explorerBaseUrl={list.explorerBaseUrl} />
                    <div className={styles.dim} style={{ fontSize: 11 }}>
                      block <Num>{formatBlock(row.executedBlockNumber)}</Num>
                    </div>
                  </>
                ) : (
                  <span className={styles.dim}>{row.indexed ? "Not settled" : "Not indexed"}</span>
                )}
              </td>
              <td className={styles.nowrap}>
                <Link className={styles.monoLink} href={`/payments/${row.paymentId}`}>
                  Investigate →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}