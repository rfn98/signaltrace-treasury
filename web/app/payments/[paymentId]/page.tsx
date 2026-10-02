/**
 * Milestone J — investigation detail.
 *
 * Server Component. It calls `investigatePayment` DIRECTLY, exactly once, and maps the single
 * outcome to the page.
 *
 * No `fetch` to the route handler this milestone already added. A Server Component calling its own
 * application's HTTP endpoint would open a second connection to the same database and the same RPC
 * node, pay the serialisation cost twice, and — worst of all — make the UI's correctness depend on
 * a network hop that does not exist on a developer's machine. The route remains available for
 * external callers; it is simply not the way the UI talks to its own service.
 *
 * The investigation service owns every refusal, so this page does not re-implement error handling.
 * An `ok: false` outcome is a RESULT here, not an exception, and each of the five codes renders
 * with its own title, explanation and — for the 422s — the partial evidence that explains the
 * refusal. A missing number is always shown as missing.
 */
import Link from "next/link";
import { connection } from "next/server";

import { EvidencePanel } from "@/components/evidence-panel";
import { InvestigatorPanel } from "@/components/investigator-panel";
import { Notice } from "@/components/notice";
import { Field, FieldList, PageHeader } from "@/components/primitives";
import { ReconciliationTable, SettlementTimeline } from "@/components/reconciliation-table";
import { VerdictPanel } from "@/components/verdict-panel";
import styles from "@/components/ui.module.css";
import { investigationDeps } from "@/lib/investigation/deps";
import { investigatePayment } from "@/lib/investigation/service";
import type { InvestigationErrorCode } from "@/lib/investigation/types";
import { CHAIN_ID, TREASURY_ADDRESS } from "@/lib/policy/types";
import { getPaymentRequests, getTreasuryByChain } from "@/lib/queries";
import { toDetailPage, type IndexedProvenance } from "@/lib/treasury/detail";
import type { AssetInfo, NetworkInfo } from "@/lib/treasury/types";

/**
 * Display metadata, read separately and best-effort.
 *
 * Provenance only: a chain name, a token symbol, the token's decimals and an explorer base URL.
 * Nothing here can reach a verdict, so failing to read it costs labels and not truth.
 *
 * Decimals are needed to render an amount read from the chain in human units. The investigation
 * result does not carry them, and adding a fourth chain reader for a display concern is not worth
 * widening the adapter, so they come from the indexed asset metadata — which is a formatting input
 * only. If they were ever wrong the visible figure would be wrong, but no policy decision, and no
 * comparison against a contract-supplied limit, could be affected: those are all in base units.
 */
async function loadDisplayMetadata(): Promise<{
  network: NetworkInfo;
  asset: AssetInfo;
  explorerBaseUrl: string;
}> {
  const indexed = await getTreasuryByChain(CHAIN_ID).catch(() => null);

  return {
    network: {
      chainId: CHAIN_ID,
      name: indexed?.chain?.name ?? "Arbitrum Sepolia",
      nativeSymbol: indexed?.chain?.nativeSymbol ?? "ETH",
      explorerBaseUrl: indexed?.chain?.explorerBaseUrl ?? "https://sepolia.arbiscan.io",
    },
    asset: {
      address: indexed?.asset?.address ?? "",
      symbol: indexed?.asset?.symbol ?? "mUSD",
      name: indexed?.asset?.name ?? "Mock USD",
      decimals: indexed?.asset?.decimals ?? 6,
    },
    explorerBaseUrl: indexed?.chain?.explorerBaseUrl ?? "https://sepolia.arbiscan.io",
  };
}

/** Indexed provenance for one payment, or null when the index has no row for it. */
async function loadIndexedProvenance(paymentId: string): Promise<IndexedProvenance | null> {
  const rows = await getPaymentRequests(TREASURY_ADDRESS).catch(() => []);
  const match = (rows as unknown as { onChainPaymentId: string }[]).find(
    (row) => String(row.onChainPaymentId) === paymentId,
  );

  return (match as unknown as IndexedProvenance) ?? null;
}

/** Explanations for each refusal code. The investigation's raw message is never shown. */
const REFUSAL_TONE: Record<InvestigationErrorCode, "caution" | "negative"> = {
  INVALID_PAYMENT_ID: "caution",
  PAYMENT_NOT_FOUND: "caution",
  EVIDENCE_INCONSISTENT: "negative",
  EVIDENCE_INSUFFICIENT: "caution",
  DEPENDENCY_UNAVAILABLE: "negative",
};

export default async function PaymentInvestigationPage(props: PageProps<"/payments/[paymentId]">) {
  await connection();

  const { paymentId } = await props.params;

  // The ONE investigation. Everything on the page comes from this single result.
  const outcome = await investigatePayment(paymentId, investigationDeps());

  const [display, indexed] = await Promise.all([
    loadDisplayMetadata(),
    loadIndexedProvenance(paymentId),
  ]);

  const model = toDetailPage(outcome, {
    indexed,
    network: display.network,
    asset: display.asset,
    explorerBaseUrl: display.explorerBaseUrl,
  });

  // Branching on `kind` rather than on a derived `detail` boolean, so the refusal path keeps its
  // narrowed type and can never accidentally read a field off the success variant.
  const detail = model.kind === "ok" ? model.detail : model.partial;
  const refusal = model.kind === "error" ? model : null;

  return (
    <main className={styles.shell}>
      <div className={styles.stack} style={{ padding: "32px 0 64px" }}>
        <PageHeader
          eyebrow="Investigation"
          title={`Payment ${paymentId}`}
          description="The verdict below is re-evaluated against current chain state. It is not a record of what was decided at the time — the settlement panel shows that."
        >
          <Link className={styles.monoLink} href="/payments">
            ← All payments
          </Link>
        </PageHeader>

        {refusal ? (
          <Notice tone={REFUSAL_TONE[refusal.code]} strong={refusal.title}>
            {refusal.explanation}
          </Notice>
        ) : null}

        {detail ? (
          <>
            <FieldList>
              <Field label="Reference">
                <span className={styles.mono}>{detail.reference}</span>
              </Field>
              <Field label="Investigation">
                <span className={styles.mono}>{detail.status}</span>
                {detail.status === "INSUFFICIENT_EVIDENCE" ? (
                  <span className={styles.dim}> · a conclusion was not reached</span>
                ) : null}
              </Field>
            </FieldList>

            <VerdictPanel verdict={detail.verdict} />

            {/*
             * On a refusal the panels below are rendered from the PARTIAL result and explicitly
             * marked, rather than hidden. The reconciliation that caused the refusal is the most
             * useful thing on the page in exactly that case.
             */}
            {refusal?.partial ? (
              <Notice tone="caution" strong="Partial result shown.">
                The investigation refused to state a verdict. What follows is the evidence and
                reconciliation it did obtain.
              </Notice>
            ) : null}

            <EvidencePanel
              evidence={detail.evidence}
              symbol={detail.asset.symbol}
              decimals={detail.asset.decimals}
            />

            <div className={styles.grid2}>
              <InvestigatorPanel investigator={detail.investigator} />
              <SettlementTimeline settlement={detail.settlement} explorerBaseUrl={detail.explorerBaseUrl} />
            </div>

            <ReconciliationTable reconciliation={detail.reconciliation} />
          </>
        ) : (
          <Notice tone={REFUSAL_TONE[refusal?.code ?? "DEPENDENCY_UNAVAILABLE"]} strong="Nothing to show.">
            The investigation returned no result for this payment, so no verdict, evidence or
            reconciliation is displayed. An absent number is shown as absent.
          </Notice>
        )}
      </div>
    </main>
  );
}