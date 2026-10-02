/**
 * Seed data for the verified Milestone D/E deployment on Arbitrum Sepolia.
 *
 * Kept separate from `seed.ts` so the data can be asserted in tests without
 * opening a database connection or performing writes.
 *
 * PROVENANCE — nothing here is invented. Every hash and block number was read
 * back from the Arbitrum Sepolia chain (cast receipt / cast call) after the
 * Milestone E broadcast; the artifact is
 * contracts/broadcast/MilestoneE.s.sol/421614/run-latest.json.
 *
 * Monetary values are exact integer base units (1 mUSD = 1_000_000 base units).
 */
import { PaymentStatus } from "@prisma/client";

export const CHAIN_ID = 421614;

export const CHAIN = {
  chainId: CHAIN_ID,
  name: "Arbitrum Sepolia",
  nativeSymbol: "ETH",
  explorerBaseUrl: "https://sepolia.arbiscan.io",
} as const;

export const TOKEN = {
  address: "0xe8B0C9500D8BD0FF5528E80Ae986F2EF2B224233",
  name: "Mock USD",
  symbol: "mUSD",
  decimals: 6,
} as const;

export const TREASURY = {
  address: "0xD14e45a90A8b8F603db5Ed21B34Fc947D1bD88E9",
  ownerAddress: "0xfcdf7Cfa55d371675E65E9bdc7546F6B85B2730e",
  agentAddress: "0x523134AbaEd332378158F64EaA14AFBc446b4169",
  paused: false,
} as const;

/**
 * The only allowlisted recipient on-chain. `stranger`
 * (0x3c27A3F19B8da067301EbC1660Df2770Cc6C31f7) is intentionally absent: it holds
 * no allowlist entry, and seeding one would assert authority that does not exist.
 */
export const RECIPIENT = {
  address: "0xcfdF67203FC90226AcfC458A39e6aFBb75AC0B30",
  approved: true,
  category: "MILESTONE-E",
  addedAt: new Date(1790773984 * 1000),
} as const;

export const STRANGER = "0x3c27A3F19B8da067301EbC1660Df2770Cc6C31f7" as const;

export type SeedPayment = {
  onChainPaymentId: bigint;
  recipientAddress: string;
  amountBaseUnits: bigint;
  reference: string;
  status: PaymentStatus;
  dayIndex: number;
  monthKey: number;
  category: string;
  requestedBy: string;
  approvedBy: string | null;
  executedBy: string | null;
  createdTxHash: string;
  approvedTxHash: string | null;
  executedTxHash: string;
  createdBlockNumber: bigint;
  approvedBlockNumber: bigint | null;
  executedBlockNumber: bigint;
  createdAt: Date;
  executedTxAt: Date;
};

export const SEED_PAYMENTS: SeedPayment[] = [
  {
    onChainPaymentId: 1n,
    recipientAddress: RECIPIENT.address,
    amountBaseUnits: 10_000_000n,
    reference:
      "0x9ca87c24678728b1a611e563c9895e5cc993b58cbf97967b4d0ef82146cd742e",
    status: PaymentStatus.EXECUTED,
    dayIndex: 20726,
    monthKey: 24321,
    category: "MILESTONE-E",
    requestedBy: TREASURY.agentAddress,
    approvedBy: null,
    executedBy: TREASURY.agentAddress,
    createdTxHash:
      "0x5e8669878636481b162077ecf2f22f5fdc5e1284baedaf9409b1422a9d077373",
    approvedTxHash: null,
    executedTxHash:
      "0xfb02b4b585da50f59a10b473684a17833980637acc82bbf4234985563f85c071",
    createdBlockNumber: 314303123n,
    approvedBlockNumber: null,
    executedBlockNumber: 314303136n,
    createdAt: new Date(1790773987 * 1000),
    executedTxAt: new Date(1790773991 * 1000),
  },
  {
    onChainPaymentId: 2n,
    recipientAddress: RECIPIENT.address,
    amountBaseUnits: 50_000_000n,
    reference:
      "0xb81b7cf82018fbf931cec3443e3374e647f30970ae96eeef179c139c02fb520c",
    status: PaymentStatus.EXECUTED,
    dayIndex: 20726,
    monthKey: 24321,
    category: "MILESTONE-E",
    requestedBy: TREASURY.agentAddress,
    approvedBy: TREASURY.ownerAddress,
    executedBy: TREASURY.ownerAddress,
    createdTxHash:
      "0xe2f9a6598ab0c5d951a281dc2cc6f79a2da1f7477273b7044520c94039bc9e14",
    approvedTxHash:
      "0x40a02a9d8a07c7faaba0bb75633507b7d959765bfafa29066aa4eb193399a101",
    executedTxHash:
      "0x8e3a76c2a73070bbe5bfb19521e0bcee6dd396bc8964190537274fd43ccf2413",
    createdBlockNumber: 314303149n,
    approvedBlockNumber: 314303162n,
    executedBlockNumber: 314303175n,
    createdAt: new Date(1790773994 * 1000),
    executedTxAt: new Date(1790774000 * 1000),
  },
];
