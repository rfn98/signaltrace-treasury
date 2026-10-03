/**
 * Verdict panel — the two facts that must never be confused, side by side.
 *
 * This component is the reason Milestone J exists. It renders:
 *
 *   POLICY DECISION   — what the deterministic engine says would happen NOW, re-evaluated against
 *                       current chain state, including for a payment that already settled.
 *   ON-CHAIN STATUS    — what has actually happened to this payment.
 *
 * For payment 2 that is "Requires human approval" beside "Executed", and both are true at once.
 * The two are rendered as two separate, explicitly labelled blocks with no shared badge and no
 * visual hierarchy that implies one outranks the other, because neither does: the policy view is
 * what the contract would do today, and the lifecycle is the history. The `authorityNote` from the
 * investigation is shown verbatim rather than replaced with friendlier prose, so the same wording
 * appears here as in the evidence.
 */
import type { VerdictPanelModel } from "@/lib/treasury/types";
import { policyReasonLabel } from "@/lib/ui/status";
import { Notice } from "./notice";
import { StatusBadge } from "./status-badge";
import styles from "./ui.module.css";

export function VerdictPanel({ verdict }: { verdict: VerdictPanelModel }) {
  const blocked = verdict.policy.token === "BLOCKED";
  const onChainMissing = verdict.lifecycle === null;
  // `ReasonCode.None` means no check failed, which is the expected reason for an approved or
  // pending payment. Rendering it would read as an unexplained verdict, so no label is shown. A
  // real failure reason still renders, and the reason code and name stay on the model either way.
  const policyReason = policyReasonLabel(verdict.policyReasonCode, verdict.policyReasonName);

  return (
    <section className={styles.card} aria-labelledby="verdict-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="verdict-heading">
          Verdict
        </h2>
        <span className={styles.label}>two independent facts</span>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.grid2}>
          <div className={styles.stackTight}>
            <span className={styles.eyebrow}>Policy decision — what the engine would do now</span>
            <StatusBadge status={verdict.policy} showMeaning />
            {policyReason ? (
              <span className={styles.label}>
                Reason <span className={styles.mono}>{policyReason}</span>
              </span>
            ) : null}
          </div>

          <div className={styles.stackTight}>
            <span className={styles.eyebrow}>On-chain status — what has happened</span>
            {onChainMissing ? (
              <span className={styles.dim}>
                Not on chain. No lifecycle status is claimed, because none exists.
              </span>
            ) : (
              <>
                <StatusBadge status={verdict.lifecycle!} showMeaning />
                <span className={styles.label}>
                  Contract enum{" "}
                  <span className={styles.mono}>
                    {verdict.lifecycleRaw} ({verdict.lifecycle!.token})
                  </span>
                </span>
              </>
            )}
          </div>
        </div>

        {blocked ? (
          <Notice tone="negative" strong="The contract would refuse this payment.">
            A failing check is shown below with its own reason code. This verdict is re-evaluated
            against current chain state and does not depend on the payment having settled.
          </Notice>
        ) : null}

        <p className={styles.label}>{verdict.policyAuthorityNote}</p>
      </div>
    </section>
  );
}