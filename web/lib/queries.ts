import "server-only";
import { prisma } from "./prisma";
import { toJsonSafe } from "./json";

/**
 * Read-only persistence helpers for the treasury index.
 *
 * These functions only mirror on-chain state into an application-readable shape.
 * They deliberately expose no mutation path: creating, approving, executing or
 * authorising a payment is the contract's job, not the database's. Nothing
 * returned here should ever be presented as proof that a payment is authorised or
 * was executed — verify against the contract for that.
 *
 * Every monetary value is returned as a base-unit BigInt, and `toJsonSafe`
 * converts it to a lossless decimal string at the JSON boundary.
 */

export async function getChainIndex() {
  const chains = await prisma.chain.findMany({
    orderBy: { chainId: "asc" },
    include: { tokens: true, treasuries: true },
  });
  return toJsonSafe(chains);
}

export async function getTreasuryByChain(chainId: number) {
  const treasury = await prisma.treasury.findFirst({
    where: { chain: { chainId } },
    include: { asset: true, chain: true },
  });
  return treasury ? toJsonSafe(treasury) : null;
}

export async function getRecipients(treasuryAddress: string) {
  const recipients = await prisma.recipient.findMany({
    where: { treasury: { address: treasuryAddress } },
    orderBy: { address: "asc" },
  });
  return toJsonSafe(recipients);
}

export async function getPaymentRequests(treasuryAddress: string) {
  const payments = await prisma.paymentRequest.findMany({
    where: { treasury: { address: treasuryAddress } },
    orderBy: { onChainPaymentId: "asc" },
    include: { recipient: true },
  });
  return toJsonSafe(payments);
}

/** Chain transaction references for a payment, for later indexing/evidence work. */
export async function getPaymentTxRefs(treasuryAddress: string, onChainPaymentId: bigint) {
  const payment = await prisma.paymentRequest.findFirst({
    where: { treasury: { address: treasuryAddress }, onChainPaymentId },
  });
  if (!payment) return null;
  return toJsonSafe({
    onChainPaymentId: payment.onChainPaymentId,
    status: payment.status,
    amountBaseUnits: payment.amountBaseUnits,
    createdTxHash: payment.createdTxHash,
    approvedTxHash: payment.approvedTxHash,
    executedTxHash: payment.executedTxHash,
    createdBlockNumber: payment.createdBlockNumber,
    approvedBlockNumber: payment.approvedBlockNumber,
    executedBlockNumber: payment.executedBlockNumber,
  });
}
