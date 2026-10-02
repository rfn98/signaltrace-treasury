import { cmp, summarise, type FieldComparison, type ReconciliationReport } from "./types";
import type { ChainSnapshot } from "@/lib/chain/adapter";
import { PaymentStatus } from "@/lib/policy/types";
import type { PaymentStatus as DbStatus } from "@prisma/client";

/**
 * Compares an on-chain snapshot against the database rows for the same treasury.
 *
 * Pure: the on-chain side is passed in already-read, so this function is unit-testable
 * without an RPC endpoint and cannot itself reach the network or write anything.
 */

/** Solidity PaymentStatus index -> the database enum name. */
const STATUS_NAME: Record<number, DbStatus> = {
  [PaymentStatus.None]: "BLOCKED", // no DB row can be None; a row always exists
  [PaymentStatus.Pending]: "PENDING",
  [PaymentStatus.AutoApproved]: "AUTO_APPROVED",
  [PaymentStatus.Approved]: "APPROVED",
  [PaymentStatus.Rejected]: "REJECTED",
  [PaymentStatus.Executed]: "EXECUTED",
  [PaymentStatus.Blocked]: "BLOCKED",
};

export type DbPayment = {
  onChainPaymentId: bigint;
  amountBaseUnits: bigint;
  status: DbStatus;
  dayIndex: number;
  monthKey: number;
  reference: string;
  recipientAddress: string;
  createdTxHash: string | null;
  createdBlockNumber: bigint | null;
  executedTxHash: string | null;
  executedBlockNumber: bigint | null;
};

export type DbSnapshot = {
  treasuryAddress: string;
  ownerAddress: string;
  agentAddress: string;
  paused: boolean;
  recipients: { address: string; approved: boolean; category: string }[];
  payments: DbPayment[];
};

export function reconcile(snapshot: ChainSnapshot, db: DbSnapshot): ReconciliationReport {
  const fields: FieldComparison[] = [];

  fields.push(cmp("treasury.address", db.treasuryAddress, snapshot.treasuryAddress, "case-insensitive"));
  fields.push(cmp("treasury.paused", String(db.paused), String(snapshot.counters.paused)));
  fields.push(
    cmp("policy.singleTxLimit", null, snapshot.policy.singleTxLimit.toString(10), "policy is not cached off-chain"),
  );
  fields.push(cmp("policy.dailyLimit", null, snapshot.policy.dailyLimit.toString(10)));
  fields.push(cmp("policy.monthlyLimit", null, snapshot.policy.monthlyLimit.toString(10)));
  fields.push(cmp("policy.autoApproveLimit", null, snapshot.policy.autoApproveLimit.toString(10)));
  fields.push(
    cmp("policy.allowUnknownRecipients", null, String(snapshot.policy.allowUnknownRecipients)),
  );
  fields.push(cmp("treasury.asset", null, snapshot.assetAddress, "from the contract, not the cache"));
  fields.push(cmp("treasury.assetDecimals", null, String(snapshot.assetDecimals)));
  fields.push(cmp("treasury.balance", null, snapshot.counters.balance.toString(10), "live token balance"));
  fields.push(cmp("treasury.lifetimeReserved", null, snapshot.counters.lifetimeReserved.toString(10)));
  fields.push(cmp("treasury.lifetimeSpent", null, snapshot.counters.lifetimeSpent.toString(10)));

  // Recipients: compare the set the DB knows about against the on-chain paymentCounterparty.
  for (const r of db.recipients) {
    fields.push(
      cmp(
        `recipient[${r.address}].approved`,
        String(r.approved),
        null,
        "requires a per-recipient on-chain read",
      ),
    );
  }

  // Payments: join on the on-chain id.
  const dbById = new Map<string, DbPayment>(db.payments.map((p) => [p.onChainPaymentId.toString(10), p]));
  const chainById = new Map<string, (typeof snapshot.payments)[number]>(
    snapshot.payments.map((p) => [p.id.toString(10), p]),
  );

  for (const [id, chainP] of chainById) {
    const dbP = dbById.get(id);
    if (!dbP) {
      fields.push(
        cmp(`payment[${id}]`, null, `${chainP.amount.toString(10)} ${STATUS_NAME[chainP.status]}`, "on-chain row missing from the database"),
      );
      continue;
    }
    const prefix = `payment[${id}]`;
    fields.push(cmp(`${prefix}.amountBaseUnits`, dbP.amountBaseUnits.toString(10), chainP.amount.toString(10)));
    fields.push(cmp(`${prefix}.status`, dbP.status, STATUS_NAME[chainP.status]));
    fields.push(cmp(`${prefix}.dayIndex`, String(dbP.dayIndex), chainP.dayIndex.toString(10)));
    fields.push(cmp(`${prefix}.monthKey`, String(dbP.monthKey), chainP.monthKey.toString(10)));
    fields.push(cmp(`${prefix}.recipient`, dbP.recipientAddress, chainP.recipient, "case-insensitive"));
    if (chainP.paymentRef) {
      fields.push(cmp(`${prefix}.paymentRef`, dbP.reference, `0x${chainP.paymentRef.replace(/^0x/, "")}`));
    }
    fields.push(cmp(`${prefix}.createdTxHash`, dbP.createdTxHash, null, "tx hash is not stored on-chain"));
    fields.push(cmp(`${prefix}.createdBlockNumber`, dbP.createdBlockNumber?.toString(10) ?? null, null, "block is not stored on-chain"));
    fields.push(cmp(`${prefix}.executedTxHash`, dbP.executedTxHash, null, "tx hash is not stored on-chain"));
    fields.push(cmp(`${prefix}.executedBlockNumber`, dbP.executedBlockNumber?.toString(10) ?? null, null, "block is not stored on-chain"));
  }

  for (const [id, dbP] of dbById) {
    if (!chainById.has(id)) {
      fields.push(cmp(`payment[${id}]`, `${dbP.amountBaseUnits.toString(10)} ${dbP.status}`, null, "database row not found on-chain"));
    }
  }
  const summary = summarise(fields);
  return {
    schemaVersion: "signaltrace.reconciliation/v1",
    chainId: snapshot.chainId,
    treasuryAddress: snapshot.treasuryAddress,
    onchainBlockNumber: snapshot.blockNumber.toString(10),
    onchainBlockTimestamp: snapshot.blockTimestamp.toString(10),
    summary,
    fields,
    overall: summary.mismatch > 0 ? "MISMATCH" : "MATCH",
  };
}
