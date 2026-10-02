/**
 * Investigator panel — the advisory layer, clearly fenced.
 *
 * Everything structural about this component exists to prevent one specific misreading: that the
 * model's opinion is part of the verdict. So:
 *
 *   - The advisory notice is rendered FIRST and unconditionally, from a constant the tests assert,
 *     so it cannot be conditionally dropped in a future edit.
 *   - `authority` is carried through the view model as the literal type `"ADVISORY_ONLY"`, so any
 *     value other than that would not typecheck.
 *   - A contradicting recommendation is shown, labelled in human phrasing ("Concern raised for
 *     review"), and never in a form that reads as a decision.
 *   - When the model was never called, the panel says WHY, distinguishing "unavailable" from
 *     "we refused to ask". Those are different events and a reader debugging an incident needs to
 *     tell them apart.
 *
 * Nothing in this file writes the verdict, and nothing in the verdict panel reads from here.
 */
import type { InvestigatorPanelModel } from "@/lib/treasury/types";
import { formatLatency } from "@/lib/ui/format";
import { ADVISORY_ONLY_NOTICE } from "@/lib/ui/status";
import { Notice } from "./notice";
import { Field, FieldList, Num } from "./primitives";
import { StatusBadge } from "./status-badge";
import styles from "./ui.module.css";

export function InvestigatorPanel({ investigator }: { investigator: InvestigatorPanelModel }) {
  const d = investigator.diagnostics;

  return (
    <section className={styles.card} aria-labelledby="investigator-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="investigator-heading">
          Model commentary
        </h2>
        <StatusBadge status={investigator.status} />
      </div>

      <div className={styles.cardBody}>
        {/* Unconditional and first. The authority boundary is not a footnote. */}
        <Notice strong={ADVISORY_ONLY_NOTICE}>
          The verdict above is produced by the deterministic policy engine and cannot be influenced
          by anything on this panel.
        </Notice>

        {investigator.gated ? (
          <Notice tone="caution" strong="The model was not asked.">
            The investigation stopped before calling a provider.
            {investigator.gates.length > 0 ? (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {investigator.gates.map((gate) => (
                  <li key={gate.code}>
                    <span className={styles.mono}>{gate.code}</span> — {gate.detail}
                    {gate.fields && gate.fields.length > 0 ? (
                      <span className={styles.dim}> ({gate.fields.join(", ")})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}

        <FieldList>
          <Field label="Recommendation">
            <span style={{ color: "var(--text)", fontWeight: 600 }}>
              {investigator.recommendationLabel}
            </span>
            <span className={styles.dim}> · {investigator.recommendation}</span>
          </Field>
          <Field label="Summary">{investigator.summary}</Field>
        </FieldList>

        {investigator.findings.length > 0 ? (
          <>
            <hr className={styles.divider} />
            <h3 className={styles.sectionTitle}>Findings</h3>
            <ul className={styles.stackTight} style={{ listStyle: "none" }}>
              {investigator.findings.map((finding, i) => (
                <li key={`${finding.type}-${i}`} className={styles.stackTight}>
                  <span className={styles.label}>
                    <span className={styles.mono}>{finding.type}</span>
                  </span>
                  <span>{finding.statement}</span>
                  {finding.evidenceKeys.length > 0 ? (
                    <span className={styles.dim} style={{ fontSize: 11 }}>
                      cited {finding.evidenceKeys.join(", ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {investigator.uncertainties.length > 0 ? (
          <>
            <hr className={styles.divider} />
            <h3 className={styles.sectionTitle}>Uncertainties the model reported</h3>
            <ul style={{ paddingLeft: 18, color: "var(--text-muted)" }}>
              {investigator.uncertainties.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </>
        ) : null}

        <hr className={styles.divider} />

        <h3 className={styles.sectionTitle}>Run details</h3>
        {d ? (
          <FieldList>
            <Field label="Provider">
              <span className={styles.mono}>
                {d.provider} · {d.model}
              </span>
            </Field>
            <Field label="Prompt">
              <span className={styles.mono}>{d.promptVersion}</span>
            </Field>
            <Field label="Validation">
              {d.validation}
              {d.ungroundedCitationCount !== null ? (
                <span className={styles.dim}> · {d.ungroundedCitationCount} ungrounded citations</span>
              ) : null}
            </Field>
            {d.recommendationConstrained ? (
              <Field label="Constrained">
                <span className={styles.label}>
                  The model&apos;s recommendation contradicted the deterministic decision and was
                  overridden.
                </span>
              </Field>
            ) : null}
            <Field label="Latency">
              <Num>{formatLatency(d.latencyMs)}</Num>
            </Field>
          </FieldList>
        ) : (
          <p className={styles.label}>
            No provider run was recorded for this investigation.
          </p>
        )}
      </div>
    </section>
  );
}