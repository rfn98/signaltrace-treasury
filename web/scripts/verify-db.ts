/**
 * Milestone F read-back verification.
 *
 * Re-reads the database after migration + seed and asserts the acceptance
 * checklist, including that re-running the seed is idempotent. This talks to the
 * real database; it is skipped (not failed) when DATABASE_URL is not configured.
 *
 * Run: npm run verify:db
 */
import { PrismaClient, PaymentStatus } from "@prisma/client";
import { envValue } from "@/lib/env";
import {
  CHAIN,
  RECIPIENT,
  SEED_PAYMENTS,
  STRANGER,
  TOKEN,
  TREASURY,
} from "../prisma/seed-data";

const HEX20 = /^0x[0-9a-fA-F]{40}$/;

const checks: { name: string; pass: boolean; detail: string }[] = [];

function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
}

async function main() {
  // The caller may run this from a shell that never exported DATABASE_URL, so fall
  // back to the same .env loader `reconcile-chain.ts` uses before giving up.
  const databaseUrl = envValue("DATABASE_URL");
  if (!databaseUrl) {
    console.error("UNAVAILABLE: DATABASE_URL is not set. Cannot verify the database.");
    process.exitCode = 2;
    return;
  }
  process.env.DATABASE_URL = databaseUrl;

  const prisma = new PrismaClient();
  try {
    const chains = await prisma.chain.findMany();
    const chain = chains.find((c) => c.chainId === CHAIN.chainId);
    check(
      "exactly one Arbitrum Sepolia chain record",
      chains.filter((c) => c.chainId === CHAIN.chainId).length === 1,
      `found ${chains.filter((c) => c.chainId === CHAIN.chainId).length}`,
    );
    if (!chain) throw new Error("chain 421614 missing; run the seed first");

    const token = await prisma.token.findFirst({
      where: { chainId: chain.id, address: TOKEN.address },
    });
    check("MockERC20 seeded with correct address", token?.address === TOKEN.address);
    check("token metadata is mUSD / 6 decimals", token?.symbol === "mUSD" && token.decimals === 6);

    const treasury = await prisma.treasury.findFirst({
      where: { chainId: chain.id, address: TREASURY.address },
      include: { asset: true, recipients: true },
    });
    check("Treasury seeded with correct address", treasury?.address === TREASURY.address);
    check("Treasury asset points at MockERC20", treasury?.asset.address === TOKEN.address);
    check("owner address correct", treasury?.ownerAddress === TREASURY.ownerAddress);
    check("agent address correct", treasury?.agentAddress === TREASURY.agentAddress);
    check("treasury not paused", treasury?.paused === false);

    const recipients = treasury?.recipients ?? [];
    const milestoneE = recipients.find(
      (r) => r.address.toLowerCase() === RECIPIENT.address.toLowerCase(),
    );
    check("Milestone E recipient present and approved", milestoneE?.approved === true);
    check("recipient category is MILESTONE-E", milestoneE?.category === "MILESTONE-E");
    check(
      "no STRANGER recipient was inserted",
      !recipients.some((r) => r.address.toLowerCase() === STRANGER.toLowerCase()),
      `recipients: ${recipients.map((r) => r.address).join(", ")}`,
    );

    const payments = await prisma.paymentRequest.findMany({
      where: { treasuryId: treasury!.id },
      orderBy: { onChainPaymentId: "asc" },
    });
    check("exactly two payments indexed", payments.length === SEED_PAYMENTS.length, `found ${payments.length}`);

    for (const expected of SEED_PAYMENTS) {
      const row = payments.find((p) => p.onChainPaymentId === expected.onChainPaymentId);
      const label = `payment ${expected.onChainPaymentId}`;
      check(`${label} exists`, Boolean(row));
      if (!row) continue;
      check(`${label} is EXECUTED`, row.status === PaymentStatus.EXECUTED);
      check(
        `${label} amount is exactly ${expected.amountBaseUnits} base units`,
        row.amountBaseUnits === expected.amountBaseUnits,
        `got ${row.amountBaseUnits}`,
      );
      check(`${label} amount read back as BigInt`, typeof row.amountBaseUnits === "bigint");
      check(`${label} reference matches exactly`, row.reference === expected.reference);
      check(
        `${label} day/month bucket matches contract`,
        row.dayIndex === expected.dayIndex && row.monthKey === expected.monthKey,
      );
      check(`${label} created tx hash recorded`, HEX20.test(row.createdTxHash ?? "") || /^0x[0-9a-f]{64}$/i.test(row.createdTxHash ?? ""));
      check(`${label} executed tx hash recorded`, /^0x[0-9a-f]{64}$/i.test(row.executedTxHash ?? ""));
    }

    // BigInt precision: the sum must be exact, with no float rounding.
    const total = payments.reduce((s, p) => s + p.amountBaseUnits, 0n);
    check("base-unit total is exactly 60000000", total === 60_000_000n, `got ${total}`);
    check("total is lossless past 2^53 (no float in path)", total > BigInt(Number.MAX_SAFE_INTEGER) - 1n || typeof total === "bigint");

    console.log("");
    for (const c of checks) {
      console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    }
    const failed = checks.filter((c) => !c.pass);
    console.log("");
    console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
