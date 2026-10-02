/**
 * Milestone J — Treasury Overview.
 *
 * Server Component. `connection()` stops prerendering so the build does not reach for an RPC
 * endpoint or a database at build time; without it Next would try to prerender this page and fail
 * on a machine that has neither configured. Every number on the page comes from
 * `loadTreasuryOverview`, which reads the chain once at a single block.
 *
 * There is no client-side fetching and no interactivity on this page. Nothing here is worth a
 * `use client` boundary, and in a treasury console a static render is a feature: what you read is
 * what the server observed, not a view that quietly refreshed under you.
 */
import Link from "next/link";
import { connection } from "next/server";

import { BalancePanel } from "@/components/balance-panel";
import { PageHeader } from "@/components/primitives";
import { CountersCard, PolicyLimitsCard } from "@/components/policy-limits-card";
import { loadTreasuryOverview } from "@/lib/treasury/overview";
import styles from "@/components/ui.module.css";

export default async function TreasuryOverviewPage() {
  await connection();
  const overview = await loadTreasuryOverview();

  return (
    <main className={styles.shell}>
      <div className={styles.stack} style={{ padding: "32px 0 64px" }}>
        <PageHeader
          eyebrow={overview.network.name}
          title="SignalTrace Treasury"
          description="A on-chain treasury whose policy is evaluated by a deterministic engine from chain state. Every figure below was read from the contract at the block shown on the balance panel."
        >
          <Link className={styles.monoLink} href="/payments">
            Payment requests →
          </Link>
        </PageHeader>

        <div className={styles.grid2}>
          <BalancePanel overview={overview} />
          <PolicyLimitsCard overview={overview} />
        </div>

        <CountersCard overview={overview} />
      </div>
    </main>
  );
}