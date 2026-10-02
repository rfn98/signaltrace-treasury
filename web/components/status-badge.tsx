/**
 * Status badge — the single place a status becomes a colour.
 *
 * Two rules live here:
 *
 *  1. `toneClass` is chosen from a closed set, so a tone always has a complete style. An unknown
 *     status arrives already degraded to `neutral` by `lib/ui/status`, so there is no path by
 *     which a status renders with no styling at all.
 *
 *  2. The badge renders a `meaning` line under the label. A colour alone is not a claim anyone
 *     can check; "Requires human approval" is. That matters most for PENDING, which is the status
 *     a reader is most likely to misread as an error.
 *
 * The full untruncated value is always available via `title`, so a hover never hides the detail
 * that the elided text dropped.
 */
import type { StatusDisplay } from "@/lib/ui/status";
import styles from "./ui.module.css";

const TONE_CLASS: Record<StatusDisplay["tone"], string> = {
  positive: styles.tonePositive,
  caution: styles.toneCaution,
  negative: styles.toneNegative,
  neutral: styles.toneNeutral,
};

export function StatusBadge({
  status,
  showMeaning = false,
}: {
  status: StatusDisplay;
  showMeaning?: boolean;
}) {
  const full = `${status.label} — ${status.meaning}`;
  return (
    <span className={`${styles.badge} ${TONE_CLASS[status.tone]}`} title={full}>
      <span className={styles.badgeLabel}>{status.label}</span>
      {showMeaning ? (
        <span className={styles.badgeMeaning}>{status.meaning}</span>
      ) : (
        /*
         * Screen readers get the sentence, not a bare colour name. Only when the meaning is not
         * already visible, so the text is never announced twice.
         */
        <span className="sr-only">{status.meaning}</span>
      )}
    </span>
  );
}