import { describe, expect, it } from "vitest";
import { PaymentStatus } from "@prisma/client";
import {
  CHAIN,
  CHAIN_ID,
  RECIPIENT,
  SEED_PAYMENTS,
  STRANGER,
  TOKEN,
  TREASURY,
} from "./seed-data";

const HEX20 = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

describe("seed data integrity", () => {
  it("targets Arbitrum Sepolia", () => {
    expect(CHAIN.chainId).toBe(421614);
    expect(CHAIN_ID).toBe(421614);
    expect(CHAIN.name).toBe("Arbitrum Sepolia");
    expect(CHAIN.nativeSymbol).toBe("ETH");
    expect(CHAIN.explorerBaseUrl).toBe("https://sepolia.arbiscan.io");
  });

  it("describes the deployed MockERC20", () => {
    expect(TOKEN.address).toMatch(HEX20);
    // Addresses are persisted in EIP-55 checksummed form, which is what the
    // deployment reports; case-sensitive comparison must match exactly.
    expect(TOKEN.address).toBe("0xe8B0C9500D8BD0FF5528E80Ae986F2EF2B224233");
    expect(TOKEN.symbol).toBe("mUSD");
    expect(TOKEN.decimals).toBe(6);
  });

  it("describes the deployed Treasury", () => {
    expect(TREASURY.address).toMatch(HEX20);
    expect(TREASURY.ownerAddress).toMatch(HEX20);
    expect(TREASURY.agentAddress).toMatch(HEX20);
    expect(TREASURY.paused).toBe(false);
  });

  it("seeds only the approved Milestone E recipient", () => {
    expect(RECIPIENT.address).toMatch(HEX20);
    expect(RECIPIENT.approved).toBe(true);
    expect(RECIPIENT.category).toBe("MILESTONE-E");
  });

  it("never seeds the stranger as a recipient", () => {
    const addresses = [
      RECIPIENT.address,
      ...SEED_PAYMENTS.map((p) => p.recipientAddress),
    ].map((a) => a.toLowerCase());
    expect(addresses).not.toContain(STRANGER.toLowerCase());
  });

  it("records the two Milestone E payments with exact base-unit amounts", () => {
    expect(SEED_PAYMENTS).toHaveLength(2);
    const p1 = SEED_PAYMENTS[0];
    const p2 = SEED_PAYMENTS[1];

    expect(p1.onChainPaymentId).toBe(1n);
    expect(p1.amountBaseUnits).toBe(10_000_000n);
    expect(p1.status).toBe(PaymentStatus.EXECUTED);
    expect(p1.requestedBy).toBe(TREASURY.agentAddress);
    expect(p1.executedBy).toBe(TREASURY.agentAddress);
    expect(p1.approvedBy).toBeNull();

    expect(p2.onChainPaymentId).toBe(2n);
    expect(p2.amountBaseUnits).toBe(50_000_000n);
    expect(p2.status).toBe(PaymentStatus.EXECUTED);
    expect(p2.requestedBy).toBe(TREASURY.agentAddress);
    expect(p2.approvedBy).toBe(TREASURY.ownerAddress);
    expect(p2.executedBy).toBe(TREASURY.ownerAddress);
  });

  it("keeps amounts as BigInt, never Number or float", () => {
    for (const p of SEED_PAYMENTS) {
      expect(typeof p.amountBaseUnits).toBe("bigint");
      expect(typeof p.onChainPaymentId).toBe("bigint");
    }
  });

  it("stores references as 32-byte hex and tx hashes as 32-byte hex", () => {
    for (const p of SEED_PAYMENTS) {
      expect(p.reference).toMatch(HEX32);
      expect(p.createdTxHash).toMatch(HEX32);
      expect(p.executedTxHash).toMatch(HEX32);
      expect(p.executedBlockNumber).not.toBeNull();
    }
  });

  it("records the manual approval only for payment 2", () => {
    expect(SEED_PAYMENTS[0].approvedTxHash).toBeNull();
    expect(SEED_PAYMENTS[0].approvedBlockNumber).toBeNull();
    expect(SEED_PAYMENTS[1].approvedTxHash).toMatch(HEX32);
    expect(SEED_PAYMENTS[1].approvedBlockNumber).not.toBeNull();
  });

  it("uses only contract lifecycle statuses", () => {
    const allowed = new Set<string>([
      "BLOCKED",
      "PENDING",
      "AUTO_APPROVED",
      "APPROVED",
      "REJECTED",
      "EXECUTED",
    ]);
    for (const p of SEED_PAYMENTS) expect(allowed.has(p.status)).toBe(true);
  });

  it("has unique on-chain ids and references", () => {
    expect(new Set(SEED_PAYMENTS.map((p) => p.onChainPaymentId)).size).toBe(
      SEED_PAYMENTS.length,
    );
    expect(new Set(SEED_PAYMENTS.map((p) => p.reference)).size).toBe(
      SEED_PAYMENTS.length,
    );
  });
});
