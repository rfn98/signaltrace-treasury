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

/**
 * Qualifier for the two role rows.
 *
 * Says the useful thing in the reader's own terms: the address shown is index metadata, and the
 * authority or role is what the chain confirms. Deliberately does NOT say the index grants it.
 * When the index has no address for the role, it says so rather than implying verification.
 */
function AuthorityNote({ known, role }: { known: boolean; role: "owner" | "agent" }) {
  if (!known) {
    return (
      <span className={styles.dim} title="No indexed address for this role. Not shown, because an absent address cannot be verified against the chain.">
        {" "}
        · not configured
      </span>
    );
  }

  const subject = role === "owner" ? "Authority" : "Role";
  return (
    <span
      className={styles.dim}
      title={`Address shown from the index; the ${subject.toLowerCase()} itself is verified on chain. The index never grants authority.`}
    >
      {" "}
      · {subject.toLowerCase()} verified on chain
    </span>
  );
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
          {/*
           * Owner and agent get a spelled-out qualifier instead of the generic SourceTag.
           *
           * The point of this product is that the index never confers authority, and that is easy
           * to state and hard to read: "from index, not authority" asks a judge to decode it. These
           * two rows say what actually matters — the address is DISPLAY metadata from the index,
           * and the authority or role behind it is confirmed against the chain. `title` keeps the
           * precise wording on hover without crowding the row.
           */}
          <Field label="Owner">
            <AddressChip address={treasury.ownerAddress} explorerBaseUrl={network.explorerBaseUrl} />
            <AuthorityNote
              known={Boolean(treasury.sources.ownerAddress === "index")}
              role="owner"
            />
          </Field>
          <Field label="Agent">
            <AddressChip address={treasury.agentAddress} explorerBaseUrl={network.explorerBaseUrl} />
            <AuthorityNote
              known={Boolean(treasury.sources.agentAddress === "index")}
              role="agent"
            />
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