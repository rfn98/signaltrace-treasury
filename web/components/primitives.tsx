/**
 * Empty and page-header primitives.
 *
 * An empty state in a treasury console is never "nothing here" without qualification: an empty
 * payment list means the chain holds no payments, which is different from the index being empty
 * and different again from the chain being unreadable. So `EmptyState` always requires a body that
 * says WHICH of those it is.
 */
import styles from "./ui.module.css";

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyTitle}>{title}</span>
      <span className={styles.emptyBody}>{children}</span>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  /** Right-aligned slot, typically a status badge or a set of links. */
  children?: React.ReactNode;
}) {
  return (
    <header className={styles.stackTight}>
      <div className={styles.rowBetween}>
        <div className={styles.stackTight}>
          {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
          <h1 className={styles.pageTitle}>{title}</h1>
        </div>
        {children ? <div className={styles.row}>{children}</div> : null}
      </div>
      {description ? <p className={styles.prose}>{description}</p> : null}
    </header>
  );
}

/** A definition-list wrapper, so label/value pairs are never built with ad-hoc divs. */
export function FieldList({ children }: { children: React.ReactNode }) {
  return <dl className={styles.fields}>{children}</dl>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Monospace numeric value. Every figure in the console goes through this. */
export function Num({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  const alignClass = align === "right" ? styles.numeric : undefined;
  return <span className={`num ${alignClass ?? ""}`.trim()}>{children}</span>;
}