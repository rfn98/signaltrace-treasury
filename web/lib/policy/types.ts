/**
 * Exact mirror of Treasury.sol semantics (Arbitrum Sepolia 421614).
 */
export const CHAIN_ID = 421614;

export const TREASURY_ADDRESS = "0xD14e45a90A8b8F603db5Ed21B34Fc947D1bD88E9";
export const TOKEN_ADDRESS = "0xe8B0C9500D8BD0FF5528E80Ae986F2EF2B224233";

export const OWNER_ADDRESS = "0xfcdf7Cfa55d371675E65E9bdc7546F6B85B2730e";
export const AGENT_ADDRESS = "0x523134AbaEd332378158F64EaA14AFBc446b4169";
export const STRANGER_ADDRESS = "0x3c27A3F19B8da067301EbC1660Df2770Cc6C31f7";
export const RECIPIENT_MILESTONE_E = "0xcfdF67203FC90226AcfC458A39e6aFBb75AC0B30";

/** ReasonCode values (stable, mirror Solidity). */
export enum ReasonCode {
  None = 0,
  InvalidRecipient = 1,
  ZeroAmount = 2,
  SelfTransfer = 3,
  UnknownRecipient = 4,
  SingleTxLimit = 5,
  DailyLimit = 6,
  MonthlyLimit = 7,
  InsufficientBalance = 8,
  Paused = 9,
  CallerNotAuthorized = 10,
  PaymentNotReserved = 11,
  NotExecutable = 12,
}

/** PaymentStatus (mirror Solidity). */
export enum PaymentStatus {
  None = 0,
  Pending = 1,
  AutoApproved = 2,
  Approved = 3,
  Rejected = 4,
  Executed = 5,
  Blocked = 6,
}

export type CheckResult = {
  reason: ReasonCode;
  limit: bigint;
  actual: bigint;
};

export type Policy = {
  singleTxLimit: bigint;
  dailyLimit: bigint;
  monthlyLimit: bigint;
  autoApproveLimit: bigint;
  allowUnknownRecipients: boolean;
};

export const MIL_E_POLICY: Policy = {
  singleTxLimit: 100_000_000n,
  dailyLimit: 500_000_000n,
  monthlyLimit: 2_000_000_000n,
  autoApproveLimit: 25_000_000n,
  allowUnknownRecipients: false,
};

export type RecipientState = {
  approved: boolean;
  category: string;
};

export type TreasuryCounters = {
  reservedDay: Record<string, bigint>;
  reservedMonth: Record<string, bigint>;
  spentDay: Record<string, bigint>;
  spentMonth: Record<string, bigint>;
  lifetimeReserved: bigint;
  lifetimeSpent: bigint;
  balance: bigint;
  paused: boolean;
};

export type Payment = {
  id: bigint;
  recipient: string;
  amount: bigint;
  status: PaymentStatus;
  dayIndex: bigint;
  monthKey: bigint;
  approvedBy?: string | null;
  category?: string;
  paymentRef?: string;
};

export type EvalOffchainDecision = "AUTO_APPROVED" | "PENDING" | "BLOCKED";
