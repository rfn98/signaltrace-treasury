/**
 * Milestone F seed — idempotent index of the already-verified Milestone D/E
 * deployment on Arbitrum Sepolia (chain 421614).
 *
 * Every value is proven on-chain; see `seed-data.ts` for provenance.
 *
 * Every write is an upsert keyed on the same unique constraint the schema
 * declares, so re-running converges instead of duplicating rows. Nothing is ever
 * deleted: the seed only inserts or updates the rows it owns.
 */
import { PrismaClient } from "@prisma/client";
import {
  CHAIN,
  RECIPIENT,
  SEED_PAYMENTS,
  TOKEN,
  TREASURY,
} from "./seed-data";

const prisma = new PrismaClient();

async function main() {
  const chain = await prisma.chain.upsert({
    where: { chainId: CHAIN.chainId },
    update: {
      name: CHAIN.name,
      nativeSymbol: CHAIN.nativeSymbol,
      explorerBaseUrl: CHAIN.explorerBaseUrl,
    },
    create: { ...CHAIN },
  });

  const token = await prisma.token.upsert({
    where: { chainId_address: { chainId: chain.id, address: TOKEN.address } },
    update: { name: TOKEN.name, symbol: TOKEN.symbol, decimals: TOKEN.decimals },
    create: { ...TOKEN, chainId: chain.id },
  });

  const treasury = await prisma.treasury.upsert({
    where: { chainId_address: { chainId: chain.id, address: TREASURY.address } },
    update: {
      tokenId: token.id,
      ownerAddress: TREASURY.ownerAddress,
      agentAddress: TREASURY.agentAddress,
      paused: TREASURY.paused,
    },
    create: { ...TREASURY, chainId: chain.id, tokenId: token.id },
  });

  const recipient = await prisma.recipient.upsert({
    where: {
      treasuryId_address: { treasuryId: treasury.id, address: RECIPIENT.address },
    },
    update: {
      approved: RECIPIENT.approved,
      category: RECIPIENT.category,
      addedAt: RECIPIENT.addedAt,
    },
    create: { ...RECIPIENT, treasuryId: treasury.id },
  });

  for (const p of SEED_PAYMENTS) {
    const data = {
      amountBaseUnits: p.amountBaseUnits,
      reference: p.reference,
      status: p.status,
      dayIndex: p.dayIndex,
      monthKey: p.monthKey,
      category: p.category,
      requestedBy: p.requestedBy,
      approvedBy: p.approvedBy,
      executedBy: p.executedBy,
      createdTxHash: p.createdTxHash,
      approvedTxHash: p.approvedTxHash,
      executedTxHash: p.executedTxHash,
      createdBlockNumber: p.createdBlockNumber,
      approvedBlockNumber: p.approvedBlockNumber,
      executedBlockNumber: p.executedBlockNumber,
      createdAt: p.createdAt,
      executedTxAt: p.executedTxAt,
    };
    // `updatedAt` is @updatedAt-managed, so it is only pinned on insert. Re-seeding
    // leaves it alone rather than pretending a later indexer run happened.
    await prisma.paymentRequest.upsert({
      where: {
        treasuryId_onChainPaymentId: {
          treasuryId: treasury.id,
          onChainPaymentId: p.onChainPaymentId,
        },
      },
      update: data,
      create: {
        ...data,
        treasuryId: treasury.id,
        recipientId: recipient.id,
        onChainPaymentId: p.onChainPaymentId,
        updatedAt: p.createdAt,
      },
    });
  }

  const [chains, tokens, treasuries, recipients, payments] = await Promise.all([
    prisma.chain.count(),
    prisma.token.count(),
    prisma.treasury.count(),
    prisma.recipient.count(),
    prisma.paymentRequest.count(),
  ]);

  console.log("Seed complete:");
  console.log(`  chain      ${chain.chainId} (total chains: ${chains})`);
  console.log(`  token      ${token.address} ${token.symbol}/${token.decimals} (total: ${tokens})`);
  console.log(`  treasury   ${treasury.address} (total: ${treasuries})`);
  console.log(
    `  recipient  ${recipient.address} approved=${recipient.approved} category=${recipient.category} (total: ${recipients})`,
  );
  console.log(`  payments   (total: ${payments})`);
  for (const p of SEED_PAYMENTS) {
    console.log(
      `    onChainPaymentId=${p.onChainPaymentId} amount=${p.amountBaseUnits} base units status=${p.status}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
