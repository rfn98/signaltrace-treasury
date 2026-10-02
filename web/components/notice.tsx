/**
 * Notice — a bordered callout for statements that qualify what is on screen.
 *
 * Used for exactly three things: the advisory-layer limitation, a caveat attached to a number, and
 * a refusal that still renders evidence. It is NOT used for errors that replace the page; those
 * are handled by the page itself. Keeping that split means a notice always sits inside a panel
 * that is otherwise readable, so a reader never has to wonder whether the panel was replaced or
 * annotated.
 */
import styles from "./ui.module.css";

export function Notice({
  children,
  tone = "info",
  strong,
}: {
  children: React.ReactNode;
  tone?: "info" | "caution" | "negative";
  strong?: string;
}) {
  const toneClass =
    tone === "caution" ? styles.noticeCaution : tone === "negative" ? styles.noticeNegative : undefined;

  return (
    <div className={`${styles.notice} ${toneClass ?? ""}`.trim()}>
      <span>
        {strong ? <span className={styles.noticeStrong}>{strong} </span> : null}
        {children}
      </span>
    </div>
  );
}