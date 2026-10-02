/**
 * Milestone J — payment list view model.
 *
 * SERVER ONLY (`import "server-only"`).
 *
 * THE JOIN, AND WHY IT EXISTS: no single existing source has everything a payment row needs.
 *
 *   - The chain knows the authoritative amount, recipient, status, category and reference.
 *   - The database knows the transaction hashes and block numbers, which are NOT stored on chain
 *     and therefore cannot be read from it.
 *
 * So the chain drives the row and the index supplies only the fields the chain physically cannot
 * hold. It is the same split Milestone G reconciliation uses, which means the list and the
 * reconciliation report can never describe different payments.
 *
 * Chain status is rendered from the CHAIN. The index's `status` column is deliberately ignored
 * here: it is a cache, and a listing that trusts a cache it is not verifying would quietly undo
 * the trust order the rest of the project is built on. The reconciliation report on the detail
 * page is where a stale cache gets reported — by Milestone G, not by the UI.
 */
import "server-only";

import { createReadClient, readChainSnapshot, readRecipient, resolveRpcUrl } from "@/lib/chain/adapter";
import { decodeBytes32 } from "@/lib/investigation/chain-state";
import { monthKeyToYearMonth } from "@/lib/policy/calendar";
import { CHAIN_ID, TREASURY_ADDRESS, type Payment } from "@/lib/policy/types";
import { getTreasuryByChain, getPaymentRequests } from "@/lib/queries";
import { lifecycleStatus } from "@/lib/ui/status";
import type { PaymentList, PaymentRow } from "./types";

function rpcUrl(): string {
  return resolveRpcUrl();
}

/**
 * The ONLY fields taken from the index.
 *
 * Deliberately trimmed to provenance: transaction hashes, block numbers, timestamps and actors.
 * The index's own `amountBaseUnits`, `status`, `category`, `reference`, `dayIndex` and
 * `monthKey` are absent, and `getPaymentRequests` is cast through `unknown`, so nothing this
 * listing shows can come from the cache even by accident. That is the trust boundary expressed as
 * a type rather than as a promise. Values are decimal strings because the query already ran
 * through `toJsonSafe`.
 */
type IndexedProvenanceRow = {
  onChainPaymentId: string;
  createdTxHash: string | null;
  approvedTxHash: string | null;
  executedTxHash: string | null;
  createdBlockNumber: string | null;
  approvedBlockNumber: string | null;
  executedBlockNumber: string | null;
  createdAt: string | null;
  executedTxAt: string | null;
};

/** Recipient facts, read from the chain because the index deliberately does not cache them. */
export type RecipientFacts = { approved: boolean; category: string };

/**
 * Joins one on-chain payment with its indexed provenance.
 *
 * Pure, and therefore directly testable, because this function IS the trust boundary: everything
 * that describes money or state comes from the first argument, everything that merely witnesses it
 * comes from the second. A payment with no indexed row is still returned — it exists on chain, and
 * hiding it would hide chain truth — with the provenance fields empty and `indexed: false`.
 */
export function toPaymentRow(
  payment: Payment,
  recipient: RecipientFacts,
  indexedRow: IndexedProvenanceRow | null,
): PaymentRow {
  return {
    paymentId: payment.id.toString(),
    // Lifecycle is rendered from the CHAIN. `indexedRow` has no status field to leak.
    lifecycle: lifecycleStatus(payment.status),
    lifecycleRaw: payment.status,
    recipient: payment.recipient,
    recipientApproved: recipient.approved,
    // The COUNTERPARTY's category, from the recipient registry. Distinct from the payment's own.
    recipientCategory: recipient.category,
    amountBaseUnits: payment.amount.toString(),
    // The PAYMENT's category, from the payment record.
    category: payment.category ? decodeBytes32(payment.category) : "—",
    reference: payment.paymentRef ? decodeBytes32(payment.paymentRef) : "—",
    dayIndex: payment.dayIndex.toString(),
    monthKey: payment.monthKey.toString(),
    // Display metadata only, so a missing key renders as a dash. Defaulting it to 0 would render
    // a confident "1970-01", which is a fabricated date rather than an absent one.
    monthLabel: payment.monthKey === undefined ? "—" : monthKeyToYearMonth(payment.monthKey),
    approvedBy: payment.approvedBy ?? null,
    createdTxHash: indexedRow?.createdTxHash ?? null,
    approvedTxHash: indexedRow?.approvedTxHash ?? null,
    executedTxHash: indexedRow?.executedTxHash ?? null,
    createdBlockNumber: indexedRow?.createdBlockNumber ?? null,
    executedBlockNumber: indexedRow?.executedBlockNumber ?? null,
    createdAt: indexedRow?.createdAt ?? null,
    executedAt: indexedRow?.executedTxAt ?? null,
    indexed: indexedRow !== null,
  };
}

/**
 * Loads every payment the chain knows about, oldest id first, with indexed provenance attached.
 *
 * Recipient allowlist state is read from the chain per distinct recipient rather than from the
 * index, because it is a policy input and the index explicitly does not cache it. Distinct
 * recipients are cached per load so a treasury paying one recipient twenty times costs one read.
 */
export async function loadPaymentList(
  treasuryAddress: string = TREASURY_ADDRESS,
): Promise<PaymentList> {
  const client = createReadClient(rpcUrl());

  const [snapshot, indexedRows, indexed] = await Promise.all([
    readChainSnapshot(client, treasuryAddress),
    // Provenance only. A failure here costs the tx hashes, not the payments themselves, so the
    // rows are allowed to come back empty rather than failing the whole listing.
    getPaymentRequests(treasuryAddress).catch(() => [] as unknown as IndexedProvenanceRow[]),
    getTreasuryByChain(CHAIN_ID).catch(() => null),
  ]);

  const byId = new Map<string, IndexedProvenanceRow>();
  for (const row of indexedRows as unknown as IndexedProvenanceRow[]) {
    byId.set(String(row.onChainPaymentId), row);
  }

  const recipientCache = new Map<string, RecipientFacts>();
  const rows: PaymentRow[] = [];

  for (const payment of snapshot.payments) {
    let recipient = recipientCache.get(payment.recipient);
    if (!recipient) {
      const state = await readRecipient(client, treasuryAddress, payment.recipient);
      recipient = { approved: state.approved, category: decodeBytes32(state.category) };
      recipientCache.set(payment.recipient, recipient);
    }

    rows.push(toPaymentRow(payment, recipient, byId.get(payment.id.toString()) ?? null));
  }

  return {
    rows,
    explorerBaseUrl: indexed?.chain?.explorerBaseUrl ?? "https://sepolia.arbiscan.io",
    asset: {
      address: snapshot.assetAddress,
      symbol: indexed?.asset?.symbol ?? "mUSD",
      name: indexed?.asset?.name ?? "Mock USD",
      decimals: snapshot.assetDecimals,
    },
  };
}