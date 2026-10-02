/**
 * Blocking loading state for the payments list.
 *
 * Server Component (the default for `loading.tsx`). The skeleton mirrors the real page geometry —
 * header block, then one card row per visible payment — so the swap when the chain read completes
 * does not move the content a reader is already looking at.
 *
 * Nothing here says "loading from the chain" in so many words on purpose: it is replaced in moments
 * and an animated placeholder on a page whose subject is "waiting for a chain read" would be
 * decoration the console does not need.
 */
import styles from "@/components/ui.module.css";

function Bar({ width }: { width: string }) {
  return <div className={styles.skeletonBar} style={{ width }} />;
}

export default function PaymentsLoading() {
  return (
    <main className={styles.shell} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading payment requests from the chain.</span>
      <div className={styles.stack} style={{ padding: "32px 0 64px" }}>
        <div className={styles.stackTight}>
          <Bar width="140px" />
          <Bar width="320px" />
          <Bar width="520px" />
        </div>

        <div className={styles.skeleton} style={{ height: 260 }}>
          <div className={styles.stackTight} style={{ padding: 16 }}>
            <Bar width="100%" />
            <Bar width="92%" />
            <Bar width="96%" />
            <Bar width="88%" />
            <Bar width="94%" />
          </div>
        </div>
      </div>
    </main>
  );
}