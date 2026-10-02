import { createReadClient, hasRole, readChainSnapshot, readRecipient } from "@/lib/chain/adapter";
import { envValue } from "@/lib/env";
import { reconcile, type DbSnapshot, type DbPayment } from "@/lib/reconcile/compare";
import type { ReconciliationReport } from "@/lib/reconcile/types";
import { PrismaClient } from "@prisma/client";

/**
 * Live Milestone G reconciliation: read the chain, read the database, compare.
 *
 * READ-ONLY by construction. The only Prisma operations used are `findMany`/`findFirst`.
 * There is no private key, no wallet, and no write path anywhere in this file or anything
 * it imports.
 *
 * Usage:  npx tsx scripts/reconcile-chain.ts
 * Env:    ARBITRUM_SEPOLIA_RPC_URL  (falls back to RPC_URL in contracts/.env)
 *         DATABASE_URL
 */

const TREASURY = "0xD14e45a90A8b8F603db5Ed21B34Fc947D1bD88E9";
const RECIPIENT = "0xcfdF67203FC90226AcfC458A39e6aFBb75AC0B30";
const OWNER_ROLE = "0xb19546dff01e856fb3f010c267a7b1c60363cf8a4664e21cc89c26224620214e";
const AGENT_ROLE = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";

/** Reads a key from .env without printing its value. */

async function main(): Promise<void> {
  const rpcUrl = envValue("ARBITRUM_SEPOLIA_RPC_URL") ?? envValue("RPC_URL");
  if (!rpcUrl) {
    console.error("UNAVAILABLE: no RPC URL (set ARBITRUM_SEPOLIA_RPC_URL or RPC_URL)");
    process.exitCode = 2;
    return;
  }
  const dbUrl = envValue("DATABASE_URL");
  if (!dbUrl) {
    console.error("UNAVAILABLE: no DATABASE_URL");
    process.exitCode = 2;
    return;
  }
  process.env.DATABASE_URL = dbUrl;

  const client = createReadClient(rpcUrl);
  const snapshot = await readChainSnapshot(client, TREASURY);
  const chainRecipient = await readRecipient(client, TREASURY, RECIPIENT);
  const ownerIsOwner = await hasRole(client, TREASURY, OWNER_ROLE as `0x${string}`, "0xfcdf7Cfa55d371675E65E9bdc7546F6B85B2730e");
  const agentIsAgent = await hasRole(client, TREASURY, AGENT_ROLE as `0x${string}`, "0x523134AbaEd332378158F64EaA14AFBc446b4169");

  const prisma = new PrismaClient();
  let db: DbSnapshot;
  try {
    const treasuryRow = await prisma.treasury.findFirst({ where: { address: TREASURY } });
    if (!treasuryRow) throw new Error(`no Treasury row for ${TREASURY}`);
    const recipients = await prisma.recipient.findMany({ where: { treasuryId: treasuryRow.id } });
    const payments = await prisma.paymentRequest.findMany({ where: { treasuryId: treasuryRow.id } });
    db = {
      treasuryAddress: treasuryRow.address,
      ownerAddress: treasuryRow.ownerAddress,
      agentAddress: treasuryRow.agentAddress,
      paused: treasuryRow.paused,
      recipients: recipients.map((r) => ({ address: r.address, approved: r.approved, category: r.category })),
      payments: payments.map(
        (p): DbPayment => ({
          onChainPaymentId: p.onChainPaymentId,
          amountBaseUnits: p.amountBaseUnits,
          status: p.status,
          dayIndex: p.dayIndex,
          monthKey: p.monthKey,
          reference: p.reference,
          recipientAddress: recipients.find((r) => r.id === p.recipientId)?.address ?? "",
          createdTxHash: p.createdTxHash,
          createdBlockNumber: p.createdBlockNumber,
          executedTxHash: p.executedTxHash,
          executedBlockNumber: p.executedBlockNumber,
        }),
      ),
    };
  } finally {
    await prisma.$disconnect();
  }

  const report: ReconciliationReport = reconcile(snapshot, db);

  console.log("=== Milestone G live reconciliation (read-only) ===");
  console.log(`chain id        : ${report.chainId}`);
  console.log(`treasury        : ${report.treasuryAddress}`);
  console.log(`block           : ${report.onchainBlockNumber} @ ${report.onchainBlockTimestamp}`);
  console.log(`db recipient ok : approved=${chainRecipient.approved} category=${chainRecipient.category}`);
  console.log(`role checks     : ownerHasOwnerRole=${ownerIsOwner} agentHasAgentRole=${agentIsAgent}`);
  console.log("");
  for (const f of report.fields) {
    const mark = f.verdict === "MATCH" ? "MATCH     " : f.verdict === "MISMATCH" ? "MISMATCH  " : "UNAVAILABLE";
    console.log(`  [${mark}] ${f.field}${f.note ? `  (${f.note})` : ""}`);
    if (f.verdict === "MISMATCH") {
      console.log(`              offchain=${f.offchain} onchain=${f.onchain}`);
    }
  }
  console.log("");
  console.log(
    `summary         : ${report.summary.match} match, ${report.summary.mismatch} mismatch, ${report.summary.unavailable} unavailable`,
  );
  console.log(`overall         : ${report.overall}`);

  if (report.overall === "MISMATCH") process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error("reconciliation failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
});
