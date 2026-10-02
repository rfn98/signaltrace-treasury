/**
 * Not-found state for an unmatched payment URL.
 *
 * Server Component (the default for `not-found.tsx`), which is what lets the strict no-client
 * boundary hold. A custom `error.tsx` could not be used here: Next 16 requires error boundaries to
 * be Client Components, and this milestone allows no `"use client"`.
 *
 * The distinction this page preserves: `PAYMENT_NOT_FOUND` means the index holds no such payment,
 * which the investigation reports in-page as a refusal with its own explanation. THIS file is for a
 * URL that is not a payment id at all — `/payments/abc` — where no investigation is run because
 * there is nothing to investigate.
 */
import Link from "next/link";

import { PageHeader } from "@/components/primitives";
import { Notice } from "@/components/notice";
import styles from "@/components/ui.module.css";

export default function PaymentNotFound() {
  return (
    <main className={styles.shell}>
      <div className={styles.stack} style={{ padding: "32px 0 64px" }}>
        <PageHeader
          eyebrow="Investigation"
          title="Not a payment id"
          description="That address does not name a payment, so no investigation was run."
        >
          <Link className={styles.monoLink} href="/payments">
            ← All payments
          </Link>
        </PageHeader>

        <Notice strong="A payment id is a decimal integer.">
          The chain numbers its payment requests from 1. Nothing was read, and no status, amount or
          verdict is claimed for this value.
        </Notice>
      </div>
    </main>
  );
}