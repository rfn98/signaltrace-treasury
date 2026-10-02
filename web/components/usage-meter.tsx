/**
 * Usage meter for one policy bucket.
 *
 * The bar is omitted entirely when the limit is unlimited. That is the whole design decision in
 * this component: an unlimited limit has no denominator, and drawing a "100% of infinity" bar
 * would put a specific false statement on screen. In that case the panel shows the committed
 * amount and says the limit is unlimited, which is the truth and requires no visual metaphor.
 *
 * Percentages come from `meterPercent` as an integer computed in BigInt, so the bar width cannot
 * drift through floating point, and the tone (`ok` / `warning` / `exceeded`) comes from
 * `usageTone` rather than being re-derived here.
 */
import type { UsageView } from "@/lib/treasury/types";
import { formatAmount, formatPercent } from "@/lib/ui/format";
import { Num } from "./primitives";
import styles from "./ui.module.css";

const TONE_COLOR = {
  ok: "var(--positive-fg)",
  warning: "var(--caution-fg)",
  exceeded: "var(--negative-fg)",
  unlimited: "var(--text-faint)",
} as const;

export function UsageMeter({ usage, symbol, decimals }: { usage: UsageView; symbol: string; decimals: number }) {
  const committed = formatAmount(usage.committed, decimals, symbol);
  const limit = formatAmount(usage.limit, decimals, symbol);
  const tone = TONE_COLOR[usage.tone];

  return (
    <div className={styles.stackTight}>
      <div className={styles.rowBetween}>
        <span className={styles.label}>{usage.bucketLabel}</span>
        {usage.unlimited ? (
          <span className={styles.label}>
            <strong style={{ color: "var(--text)" }}>Unlimited</strong>
          </span>
        ) : (
          <span className={styles.label}>
            <Num>{formatPercent(BigInt(usage.committed), BigInt(usage.limit))}</Num> of{" "}
            <Num>
              <strong style={{ color: "var(--text)" }}>{limit}</strong>
            </Num>
          </span>
        )}
      </div>

      {usage.unlimited ? null : (
        <div
          role="meter"
          aria-valuenow={usage.usedPercent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${usage.bucketLabel} usage`}
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--surface-well)",
            border: "1px solid var(--line)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              // `usedPercent` is null exactly when the bar is not drawn, so this is never NaN.
              width: `${usage.usedPercent ?? 0}%`,
              height: "100%",
              background: tone,
              transition: "width var(--transition)",
            }}
          />
        </div>
      )}

      <div className={styles.rowBetween}>
        <span className={styles.label}>
          Committed <Num>{committed}</Num>
        </span>
        {!usage.unlimited ? (
          <span className={styles.label}>
            Remaining{" "}
            <Num>
              <strong style={{ color: tone }}>{formatAmount(usage.remaining, decimals, symbol)}</strong>
            </Num>
          </span>
        ) : null}
      </div>

      {usage.tone === "exceeded" ? (
        <p className={styles.label} style={{ color: "var(--negative-fg)" }}>
          Committed above the configured limit. The contract would refuse the next payment.
        </p>
      ) : null}
    </div>
  );
}