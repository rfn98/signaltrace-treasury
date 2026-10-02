/**
 * Milestone J — Payment Requests list.
 *
 * Server Component. The table's chain status comes from `readChainSnapshot`; indexed transaction
 * hashes are attached from the database. The policy verdict is deliberately absent here — see
 * `components/payment-table.tsx` for why.
 */
import Link from "next/link";
import { connection } from "next/server";

import { PaymentTable } from "@/components/payment-table";
import { PageHeader } from "@/components/primitives";
import { loadPaymentList } from "@/lib/treasury/payment-list";
import styles from "@/components/ui.module.css";

export default async function PaymentsPage() {
  await connection();
  const list = await loadPaymentList();

  return (
    <main className={styles.shell}>
      <div className={styles.stack} style={{ padding: "32px 0 64px" }}>
        <PageHeader
          eyebrow="On-chain record"
          title="Payment requests"
          description="Every request the treasury contract has recorded, with its on-chain status. Amounts, recipients and statuses are read from the chain; transaction hashes come from the index, which the chain does not store."
        >
          <Link className={styles.monoLink} href="/">
            ← Treasury overview
          </Link>
        </PageHeader>

        <section className={styles.card} aria-label="Payment requests">
          <PaymentTable list={list} />
        </section>
      </div>
    </main>
  );
}