/**
 * Address and hash display.
 *
 * Truncation is a convenience, never the record: the full value is always in the DOM (as `title`
 * and as the link target), and a copy is never silently truncated in a way the reader cannot
 * recover. A link is only rendered when a real explorer base URL was supplied — `explorerUrl`
 * returns null rather than a dead link, and this component honours that.
 */
import { explorerUrl, shortAddress, shortHash } from "@/lib/ui/format";
import styles from "./ui.module.css";

export function AddressChip({
  address,
  explorerBaseUrl,
  label,
}: {
  address: string | null;
  explorerBaseUrl?: string | null;
  label?: string;
}) {
  if (!address || address === "—") {
    return <span className={styles.dim}>Not available</span>;
  }

  const href = explorerBaseUrl ? explorerUrl(explorerBaseUrl, "address", address) : null;
  const text = shortAddress(address);

  if (!href) {
    // No explorer configured: show the truncated value with the full one on hover, and no link.
    return (
      <span className={styles.mono} title={address}>
        {text}
        {label ? <span className={styles.dim}> {label}</span> : null}
      </span>
    );
  }

  return (
    <a className={styles.monoLink} href={href} target="_blank" rel="noopener noreferrer" title={address}>
      {text}
      {label ? <span className={styles.dim}> {label}</span> : null}
    </a>
  );
}

export function HashLink({
  hash,
  explorerBaseUrl,
  fallback = "Not indexed",
}: {
  hash: string | null;
  explorerBaseUrl?: string | null;
  fallback?: string;
}) {
  if (!hash) {
    return <span className={styles.dim}>{fallback}</span>;
  }

  const href = explorerBaseUrl ? explorerUrl(explorerBaseUrl, "tx", hash) : null;
  const text = shortHash(hash);

  if (!href) {
    return (
      <span className={styles.mono} title={hash}>
        {text}
      </span>
    );
  }

  return (
    <a className={styles.monoLink} href={href} target="_blank" rel="noopener noreferrer" title={hash}>
      {text}
    </a>
  );
}

export function FullIdentifier({ value, mono = true }: { value: string | null; mono?: boolean }) {
  if (!value || value === "—") return <span className={styles.dim}>Not available</span>;
  return (
    <span className={mono ? styles.mono : undefined} title={value}>
      {value}
    </span>
  );
}