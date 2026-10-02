/**
 * Blocking loading state for an investigation.
 *
 * Server Component. It mirrors the detail page's real panel count and heights, because this page
 * performs several chain reads and a full evidence build before it can render anything true. A
 * skeleton that matches the finished layout means the reader's eye lands in the same place
 * afterwards.
 */
import styles from "@/components/ui.module.css";

function Bar({ width }: { width: string }) {
  return <div className={styles.skeletonBar} style={{ width }} />;
}

function Panel({ height }: { height: number }) {
  return (
    <div className={styles.skeleton} style={{ height }}>
      <div className={styles.stackTight} style={{ padding: 16 }}>
        <Bar width="180px" />
        <Bar width="70%" />
        <Bar width="55%" />
      </div>
    </div>
  );
}

export default function InvestigationLoading() {
  return (
    <main className={styles.shell} aria-busy="true" aria-live="polite">
      <span className="sr-only">Investigating this payment against current chain state.</span>
      <div className={styles.stack} style={{ padding: "32px 0 64px" }}>
        <div className={styles.stackTight}>
          <Bar width="120px" />
          <Bar width="240px" />
          <Bar width="480px" />
        </div>

        <Panel height={172} />
        <div className={styles.grid2}>
          <Panel height={220} />
          <Panel height={220} />
        </div>
        <Panel height={280} />
      </div>
    </main>
  );
}