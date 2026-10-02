/**
 * Policy limits and treasury counters.
 *
 * Every value here is the contract's, read directly. Nothing is recomputed in TypeScript, so the
 * "0 means UNLIMITED" rule and the auto-approve inversion cannot drift from Treasury.sol — which
 * is why `PolicyLimitView` carries `zeroMeans` and `disabled` rather than leaving each component to
 * remember which of the four limits behaves differently.
 *
 * The auto-approve row is the reason that field exists. A treasury with `autoApproveLimit = 0` has
 * auto-approval switched OFF, and rendering that as "Unlimited" would tell an operator their
 * human-in-the-loop control is off when in fact nothing would ever settle unattended.
 */
import type { PolicyLimitView, TreasuryOverview } from "@/lib/treasury/types";
import { formatAmount } from "@/lib/ui/format";
import { Notice } from "./notice";
import { Field, FieldList, Num } from "./primitives";
import { UsageMeter } from "./usage-meter";
import styles from "./ui.module.css";

function LimitValue({ limit, symbol, decimals }: { limit: PolicyLimitView; symbol: string; decimals: number }) {
  if (limit.disabled) {
    return (
      <span className={`${styles.badge} ${styles.toneCaution}`.trim()}>
        <span className={styles.badgeLabel}>Disabled</span>
        <span className={styles.badgeMeaning}>Nothing settles without a human approval</span>
      </span>
    );
  }

  if (limit.unlimited) {
    return (
      <span className={`${styles.badge} ${styles.toneNeutral}`.trim()}>
        <span className={styles.badgeLabel}>Unlimited</span>
      </span>
    );
  }

  return (
    <Num>
      {formatAmount(limit.limit, decimals, symbol)}
    </Num>
  );
}

export function PolicyLimitsCard({ overview }: { overview: TreasuryOverview }) {
  const { policy, usage, asset } = overview;
  const limits = [policy.singleTxLimit, policy.dailyLimit, policy.monthlyLimit, policy.autoApproveLimit];

  return (
    <section className={styles.card} aria-labelledby="limits-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="limits-heading">
          Policy limits
        </h2>
        <span className={styles.label}>as configured in the contract</span>
      </div>

      <div className={styles.cardBody}>
        <FieldList>
          {limits.map((limit) => (
            <Field key={limit.id} label={limit.label}>
              <LimitValue limit={limit} symbol={asset.symbol} decimals={asset.decimals} />
              {limit.unlimited ? (
                <span className={styles.dim}> · no ceiling configured</span>
              ) : limit.disabled ? (
                <span className={styles.dim}> · 0 disables this, it does not remove the limit</span>
              ) : null}
            </Field>
          ))}
          <Field label="Unknown recipients">
            {policy.allowUnknownRecipients ? (
              <span className={`${styles.badge} ${styles.toneCaution}`.trim()}>
                <span className={styles.badgeLabel}>Allowed</span>
                <span className={styles.badgeMeaning}>Payments may go to addresses not on the allowlist</span>
              </span>
            ) : (
              <span className={`${styles.badge} ${styles.tonePositive}`.trim()}>
                <span className={styles.badgeLabel}>Rejected</span>
                <span className={styles.badgeMeaning}>Recipients must be on the allowlist</span>
              </span>
            )}
          </Field>
        </FieldList>

        {overview.unboundedAutoApproval ? (
          <Notice tone="caution" strong="Unbounded auto-approval is active.">
            The contract reports no effective cap on automatic approval. Every payment this engine
            settles on its own is one no human will ever see.
          </Notice>
        ) : null}

        <hr className={styles.divider} />

        <h3 className={styles.sectionTitle}>Usage this period</h3>
        <div className={styles.stack}>
          {usage.map((u) => (
            <UsageMeter key={u.bucket} usage={u} symbol={asset.symbol} decimals={asset.decimals} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function CountersCard({ overview }: { overview: TreasuryOverview }) {
  const { counters, asset } = overview;
  return (
    <section className={styles.card} aria-labelledby="counters-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="counters-heading">
          Lifetime counters
        </h2>
        <span className={styles.label}>from the chain</span>
      </div>
      <div className={styles.cardBody}>
        <FieldList>
          <Field label="Payments">
            <Num>{counters.paymentCount}</Num>
          </Field>
          <Field label="Reserved">
            <Num>{formatAmount(counters.lifetimeReserved, asset.decimals, asset.symbol)}</Num>
            <span className={styles.dim}> · committed but not yet spent</span>
          </Field>
          <Field label="Spent">
            <Num>{formatAmount(counters.lifetimeSpent, asset.decimals, asset.symbol)}</Num>
            <span className={styles.dim}> · settled to recipients</span>
          </Field>
        </FieldList>
      </div>
    </section>
  );
}