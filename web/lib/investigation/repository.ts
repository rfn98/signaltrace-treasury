/**
 * Milestone I — read-only persistence.
 *
 * The only Prisma operations used here are `findFirst`/`findMany`. There is no `create`,
 * `update`, `delete` or `$transaction`, and this file deliberately does not import the
 * investigator, so the AI has no path to a database handle even by accident.
 *
 * This mirrors the existing `lib/queries.ts` conventions (server-only, raw BigInt values
 * rather than pre-stringified ones). Note `lib/queries.ts` is the JSON-serialisation boundary
 * used by routes; this layer keeps native BigInts because it feeds the deterministic policy
 * engine, which must never round-trip a base-unit amount through a JS number.
 */
import "server-only";
import type { PrismaClient } from "@prisma/client";
import type { DbPayment, DbSnapshot } from "@/lib/reconcile/compare";
import { prisma } from "@/lib/prisma";
import type { PaymentRecord, PaymentRepository } from "./types";

/** Case-insensitive address match, so checksum casing can never cause a false miss. */
function byAddress(address: string) {
  return { equals: address, mode: "insensitive" as const };
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async findPayment(onChainPaymentId: bigint): Promise<PaymentRecord | null> {
    const row = await this.db.paymentRequest.findFirst({
      where: { onChainPaymentId },
      include: { treasury: true, recipient: true },
    });
    if (!row) return null;
    return {
      onChainPaymentId: row.onChainPaymentId,
      dbRowId: row.id,
      reference: row.reference,
      category: row.category,
      amountBaseUnits: row.amountBaseUnits,
      recipientAddress: row.recipient.address,
      status: row.status,
      dayIndex: row.dayIndex,
      monthKey: row.monthKey,
      createdTxHash: row.createdTxHash,
      createdBlockNumber: row.createdBlockNumber,
      executedTxHash: row.executedTxHash,
      executedBlockNumber: row.executedBlockNumber,
      treasuryAddress: row.treasury.address,
    };
  }

  /**
   * Builds the Milestone G `DbSnapshot` for one treasury.
   *
   * Every payment for the treasury is loaded, not just the one under investigation: Milestone G
   * reconciliation is defined over the whole treasury, and narrowing it here would mean
   * re-implementing (and silently weakening) the comparison rather than reusing it.
   */
  async loadDbSnapshot(treasuryAddress: string): Promise<DbSnapshot | null> {
    const treasury = await this.db.treasury.findFirst({
      where: { address: byAddress(treasuryAddress) },
      include: {
        recipients: true,
        payments: { orderBy: { onChainPaymentId: "asc" }, include: { recipient: true } },
      },
    });
    if (!treasury) return null;

    const payments: DbPayment[] = treasury.payments.map((p) => ({
      onChainPaymentId: p.onChainPaymentId,
      amountBaseUnits: p.amountBaseUnits,
      status: p.status,
      dayIndex: p.dayIndex,
      monthKey: p.monthKey,
      reference: p.reference,
      recipientAddress: p.recipient.address,
      createdTxHash: p.createdTxHash,
      createdBlockNumber: p.createdBlockNumber,
      executedTxHash: p.executedTxHash,
      executedBlockNumber: p.executedBlockNumber,
    }));

    return {
      treasuryAddress: treasury.address,
      ownerAddress: treasury.ownerAddress,
      agentAddress: treasury.agentAddress,
      paused: treasury.paused,
      recipients: treasury.recipients.map((r) => ({
        address: r.address,
        approved: r.approved,
        category: r.category,
      })),
      payments,
    };
  }
}