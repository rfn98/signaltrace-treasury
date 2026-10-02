/**
 * Balance and treasury identity panel.
 *
 * The balance is the single most consequential number on the overview, so it is presented with its
 * unit, its decimals and the block it was observed at. `observedAtBlock` is not decoration: without
 * it a reader cannot tell a settled balance from one that is about to change, and the whole
 * console is built on not overstating what a read can support.
 *
 * Owner and agent are shown from the database index and are labelled as such in the row itself.
 * They are configuration, not authority: nothing in this product decides anything from them, and a
 * reader should be able to see that without reading the source.
 */
import type { TreasuryOverview } from "@/lib/treasury/types";
import { formatAmount, formatBlock, formatTimestamp } from "@/lib/ui/format";
import { AddressChip, FullIdentifier } from "./address-chip";
import { Field, FieldList, Num } from "./primitives";
import styles from "./ui.module.css";

/** Per-field provenance, rendered next to the value it qualifies. */
function SourceTag({ source }: { source: string }) {
  const text =
    source === "chain"
      ? "from chain"
      : source === "index"
        ? "from index, not authority"
        : source === "engine"
          ? "computed by engine"
          : "not obtained";
  return <span className={styles.dim}> · {text}</span>;
}

export function BalancePanel({ overview }: { overview: TreasuryOverview }) {
  const { asset, balance, treasury, network } = overview;
  const paused = treasury.paused;

  return (
    <section className={styles.card} aria-labelledby="balance-heading">
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle} id="balance-heading">
          Treasury balance
        </h2>
        {/* Paused is authority, so it is the loudest single fact on this card. */}
        <span className={`${styles.badge} ${paused ? styles.toneNegative : styles.tonePositive}`.trim()}>
          <span className={styles.badgeLabel}>
            {paused ? "Paused — no new payments accepted" : "Active — accepting payments"}
          </span>
        </span>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.stackTight}>
          <div className={styles.row} style={{ alignItems: "baseline", gap: 10 }}>
            <Num>
              <strong style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>
                {formatAmount(balance, asset.decimals, asset.symbol)}
              </strong>
            </Num>
            <span className={styles.label}>{asset.name}</span>
          </div>
          <p className={styles.label}>
            Held by{" "}
            <FullIdentifier value={treasury.address} />{" "}
            <span className={styles.dim}>· on {network.name}</span>
          </p>
        </div>

        <hr className={styles.divider} />

        <FieldList>
          <Field label="Token">
            <FullIdentifier value={asset.address} />
            <span className={styles.dim}>
              {" "}
              · {asset.decimals} decimals{SourceTag({ source: treasury.sources.address })}
            </span>
          </Field>
          <Field label="Owner">
            <AddressChip address={treasury.ownerAddress} explorerBaseUrl={network.explorerBaseUrl} />
            <SourceTag source={treasury.sources.ownerAddress} />
          </Field>
          <Field label="Agent">
            <AddressChip address={treasury.agentAddress} explorerBaseUrl={network.explorerBaseUrl} />
            <SourceTag source={treasury.sources.agentAddress} />
          </Field>
          <Field label="Observed at">
            <Num>block {formatBlock(overview.observedAtBlock)}</Num>
            <span className={styles.dim}> · {formatTimestamp(overview.observedAtTimestamp)} UTC</span>
          </Field>
        </FieldList>
      </div>
    </section>
  );
}