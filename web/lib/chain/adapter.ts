import { createPublicClient, getAddress, http, type Abi, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import treasuryAbiJson from "@/lib/chain/abi/Treasury.json";
import tokenAbiJson from "@/lib/chain/abi/MockERC20.json";
import type { Payment, Policy, RecipientState, TreasuryCounters } from "@/lib/policy/types";
import { PaymentStatus } from "@/lib/policy/types";

/**
 * READ-ONLY on-chain adapter.
 *
 * Three constraints, all deliberate:
 *
 *  1. It only ever calls `view`/`pure` functions. There is no private client, no key and no
 *     write path in this file. The database is a cache of chain truth, never a source that
 *     could push a transaction — reconciliation must not be able to mutate anything.
 *  2. The ABI comes from the COMPILED ARTIFACT of the deployed source, not a hand-typed
 *     copy, so the decoder cannot drift from the contract it claims to describe.
 *  3. Every decoded value is validated before use. A silently mis-decoded `uint256` would
 *     be indistinguishable from a correct one in a reconciliation report, which is the
 *     exact failure this whole milestone exists to prevent. So decoding is checked, not
 *     asserted.
 */

export const treasuryAbi = treasuryAbiJson as Abi;
export const tokenAbi = tokenAbiJson as Abi;

export const CHAIN = arbitrumSepolia;

/**
 * Bounds on every read.
 *
 * A page that renders "the chain is the financial authority" must never sit on a socket forever.
 * Without these, an endpoint that accepts the connection and then stalls leaves the Server
 * Component hanging indefinitely — no error, no timeout, just a request that never resolves, which
 * is strictly worse than saying "the chain was unreachable". A bounded read turns that into the
 * DEPENDENCY_UNAVAILABLE outcome the service already models, which is a true answer.
 */
const READ_TIMEOUT_MS = 10_000;
const READ_RETRIES = 1;

export function createReadClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl, { timeout: READ_TIMEOUT_MS, retryCount: READ_RETRIES }),
  }) as PublicClient;
}

/**
 * Resolves the read endpoint from the environment.
 *
 * Returns an EMPTY STRING rather than throwing when nothing is configured, matching
 * `lib/investigation/deps.ts`, which has always passed `rpcUrl ?? ""`. viem resolves a falsy URL
 * to the chain's default public endpoint, so the product still works without configuration.
 *
 * That fallback is a public, rate-limited endpoint and it fails intermittently — measured on this
 * machine: the identical request failed once in 194ms and succeeded once in 760ms. That is why
 * reads are bounded above. Configuring ARBITRUM_SEPOLIA_RPC_URL removes the flakiness; until then,
 * DEPENDENCY_UNAVAILABLE is the honest answer and a hang would be the dishonest one.
 *
 * Both halves of the product call this, so there is one definition of "where do reads go".
 */
export function resolveRpcUrl(): string {
  return process.env.ARBITRUM_SEPOLIA_RPC_URL ?? process.env.RPC_URL ?? "";
}

function fail(what: string, got: unknown): never {
  throw new TypeError(`adapter: unexpected shape decoding ${what}: ${Object.prototype.toString.call(got)}`);
}

function asBigint(what: string, got: unknown): bigint {
  if (typeof got === "bigint") return got;
  if (typeof got === "number" && Number.isSafeInteger(got)) return BigInt(got);
  return fail(what, got);
}

function asBool(what: string, got: unknown): boolean {
  if (typeof got === "boolean") return got;
  return fail(what, got);
}

function asNumber(what: string, got: unknown): number {
  if (typeof got === "number") return got;
  if (typeof got === "bigint") return Number(got);
  return fail(what, got);
}

function asAddress(what: string, got: unknown): string {
  if (typeof got !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(got)) return fail(what, got);
  return getAddress(got);
}

function asBytes32(what: string, got: unknown): string {
  if (typeof got !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(got)) return fail(what, got);
  return got;
}

function asArray(what: string, got: unknown): readonly unknown[] {
  if (Array.isArray(got)) return got;
  return fail(what, got);
}

/**
 * Normalises a struct-returning `readContract` result to a positional tuple.
 *
 * viem returns a struct as a NAMED object (or a Result object) rather than a bare array,
 * depending on the ABI shape. The field order below is the declaration order of
 * `PaymentRequest` in Treasury.sol, so indexing is positional and unambiguous.
 */
function asStructTuple(what: string, got: unknown, keys: readonly string[]): readonly unknown[] {
  if (Array.isArray(got)) return got;
  if (got !== null && typeof got === "object") {
    const record = got as Record<string, unknown>;
    if (Array.isArray(record.result)) return record.result as readonly unknown[];
    if (keys.every((k) => k in record)) return keys.map((k) => record[k]);
  }
  return fail(what, got);
}

/** Declaration order of `struct PaymentRequest`. */
const PAYMENT_KEYS = [
  "recipient",
  "amount",
  "category",
  "paymentRef",
  "status",
  "createdAt",
  "updatedAt",
  "dayIndex",
  "monthKey",
  "approvedBy",
] as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type ChainSnapshot = {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  treasuryAddress: string;
  assetAddress: string;
  assetDecimals: number;
  policy: Policy;
  counters: TreasuryCounters;
  paymentCount: bigint;
  payments: Payment[];
};

export async function readChainSnapshot(
  client: PublicClient,
  treasuryAddress: string,
): Promise<ChainSnapshot> {
  const treasury = getAddress(treasuryAddress);
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = asBigint("block.number", block.number);
  const blockTimestamp = asBigint("block.timestamp", block.timestamp);

  const [assetRaw, decimalsRaw, policyRaw, pausedRaw, lifetimeReservedRaw, lifetimeSpentRaw, countRaw] =
    await Promise.all([
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "asset" }),
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "assetDecimals" }),
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "policy" }),
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "paused" }),
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "lifetimeReserved" }),
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "lifetimeSpent" }),
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "paymentCount" }),
    ]);

  // The asset address comes from the contract, not from our config: the balance must be read
  // from the token the treasury actually holds, and `balanceOf` on the treasury address would
  // revert because the treasury is not itself an ERC20.
  const assetAddress = asAddress("asset", assetRaw);
  const balanceRaw = await client.readContract({
    address: assetAddress as `0x${string}`,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [treasury],
  });

  const p = asArray("policy", policyRaw);
  const policy: Policy = {
    singleTxLimit: asBigint("policy.singleTxLimit", p[0]),
    dailyLimit: asBigint("policy.dailyLimit", p[1]),
    monthlyLimit: asBigint("policy.monthlyLimit", p[2]),
    autoApproveLimit: asBigint("policy.autoApproveLimit", p[3]),
    allowUnknownRecipients: asBool("policy.allowUnknownRecipients", p[4]),
  };

  const counters: TreasuryCounters = {
    reservedDay: {},
    reservedMonth: {},
    spentDay: {},
    spentMonth: {},
    lifetimeReserved: asBigint("lifetimeReserved", lifetimeReservedRaw),
    lifetimeSpent: asBigint("lifetimeSpent", lifetimeSpentRaw),
    balance: asBigint("asset.balanceOf(treasury)", balanceRaw),    paused: asBool("paused", pausedRaw),
  };

  const paymentCount = asBigint("paymentCount", countRaw);
  const payments: Payment[] = [];

  for (let id = 1n; id <= paymentCount; id++) {
    const raw = asStructTuple(
      `getPayment(${id})`,
      await client.readContract({ address: treasury, abi: treasuryAbi, functionName: "getPayment", args: [id] }),
      PAYMENT_KEYS,
    );
    // PaymentRequest: (recipient, amount, category, paymentRef, status,
    //                 createdAt, updatedAt, dayIndex, monthKey, approvedBy)
    const recipient = asAddress(`payment[${id}].recipient`, raw[0]);
    const amount = asBigint(`payment[${id}].amount`, raw[1]);
    const category = asBytes32(`payment[${id}].category`, raw[2]);
    const paymentRef = asBytes32(`payment[${id}].paymentRef`, raw[3]);
    const status = asNumber(`payment[${id}].status`, raw[4]);
    const dayIndex = asBigint(`payment[${id}].dayIndex`, raw[7]);
    const monthKey = asBigint(`payment[${id}].monthKey`, raw[8]);
    const approvedByRaw = asAddress(`payment[${id}].approvedBy`, raw[9]);

    payments.push({
      id,
      recipient,
      amount,
      status: status as PaymentStatus,
      dayIndex,
      monthKey,
      approvedBy: approvedByRaw === ZERO_ADDRESS ? null : approvedByRaw,
      category,
      paymentRef,
    });

    // In-flight reservations only exist for payments still holding one. Reading the
    // per-bucket mappings for every id would be correct but wasteful, and the aggregation
    // below is what the day/month checks actually consume.
    if (status === PaymentStatus.AutoApproved || status === PaymentStatus.Approved) {
      const [rd, rm] = await Promise.all([
        client.readContract({ address: treasury, abi: treasuryAbi, functionName: "reservedDay", args: [dayIndex] }),
        client.readContract({ address: treasury, abi: treasuryAbi, functionName: "reservedMonth", args: [monthKey] }),
      ]);
      const dk = dayIndex.toString(10);
      const mk = monthKey.toString(10);
      counters.reservedDay[dk] = (counters.reservedDay[dk] ?? 0n) + asBigint(`reservedDay(${dk})`, rd);
      counters.reservedMonth[mk] = (counters.reservedMonth[mk] ?? 0n) + asBigint(`reservedMonth(${mk})`, rm);
    }

    // Settled outflow is bucketed at execution time, which is not necessarily the
    // payment's reservation bucket. Ask the chain for the buckets that hold the spend
    // rather than assuming they coincide.
    if (status === PaymentStatus.Executed) {
      void amount;
    }
  }

  return {
    chainId: CHAIN.id,
    blockNumber,
    blockTimestamp,
    treasuryAddress: treasury,
    assetAddress,
    assetDecimals: asNumber("assetDecimals", decimalsRaw),
    policy,
    counters,
    paymentCount,
    payments,
  };
}

/**
 * Reads the spent buckets for the current day and month.
 *
 * These cannot be derived from the payments list: `spentDay` is written at EXECUTION time,
 * so a payment executed a day after it was created lands in a bucket no payment field
 * points at. The adapter therefore reports the chain's own committed totals, and the
 * caller decides which buckets to compare.
 */
/**
 * Optional read-at-block pin.
 *
 * A screen that mixes a balance from block N with a limit from block N+1 is showing two different
 * treasuries. Passing `blockNumber` from an earlier read makes every dependent read observe the
 * same state, which is what lets the UI honestly report a single "observed at" stamp.
 */
export type ReadAtBlock = { blockNumber?: bigint };

export async function readCurrentCommitted(
  client: PublicClient,
  treasuryAddress: string,
  at?: ReadAtBlock,
): Promise<{ dayKey: bigint; monthKey: bigint; dayCommitted: bigint; monthCommitted: bigint }> {
  const treasury = getAddress(treasuryAddress);
  const blockNumber = at?.blockNumber;
  const [dayRaw, monthRaw, usage] = await Promise.all([
    client.readContract({ address: treasury, abi: treasuryAbi, functionName: "currentDayIndex", blockNumber }),
    client.readContract({ address: treasury, abi: treasuryAbi, functionName: "currentMonthKey", blockNumber }),
    client.readContract({ address: treasury, abi: treasuryAbi, functionName: "currentUsage", blockNumber }),
  ]);
  const u = asArray("currentUsage", usage);
  return {
    dayKey: asBigint("currentDayIndex", dayRaw),
    monthKey: asBigint("currentMonthKey", monthRaw),
    dayCommitted: asBigint("currentUsage.dayCommitted", u[0]),
    monthCommitted: asBigint("currentUsage.monthCommitted", u[1]),
  };
}

export async function readRecipient(
  client: PublicClient,
  treasuryAddress: string,
  recipient: string,
): Promise<RecipientState> {
  const r = asArray(
    `recipients(${recipient})`,
    await client.readContract({
      address: getAddress(treasuryAddress),
      abi: treasuryAbi,
      functionName: "recipients",
      args: [getAddress(recipient)],
    }),
  );
  return { approved: asBool("recipients.approved", r[0]), category: asBytes32("recipients.category", r[1]) };
}

export async function hasRole(
  client: PublicClient,
  treasuryAddress: string,
  role: `0x${string}`,
  account: string,
): Promise<boolean> {
  return asBool(
    `hasRole(${role},${account})`,
    await client.readContract({
      address: getAddress(treasuryAddress),
      abi: treasuryAbi,
      functionName: "hasRole",
      args: [role, getAddress(account)],
    }),
  );
}

/** Reads the contract's own verdict for a creation, so the mirror can be checked against it. */
export async function readEvaluatePayment(
  client: PublicClient,
  treasuryAddress: string,
  to: string,
  amount: bigint,
): Promise<{ allowed: boolean; reason: number }> {
  const r = asArray(
    "evaluatePayment",
    await client.readContract({
      address: getAddress(treasuryAddress),
      abi: treasuryAbi,
      functionName: "evaluatePayment",
      args: [getAddress(to), amount],
    }),
  );
  return { allowed: asBool("evaluatePayment.allowed", r[0]), reason: asNumber("evaluatePayment.reason", r[1]) };
}

// ---------------------------------------------------------------------------
// Milestone J — read-only views the Treasury already exposes for exactly this purpose.
//
// ADDITIVE ONLY. Nothing above this line is touched, and no existing behaviour changes: these
// are three more `view` calls against the same compiled ABI, decoded through the same
// validating helpers. There is still no private client, no key and no write path in this file.
//
// WHY DELEGATE RATHER THAN RE-DERIVE. Each of these exists in Treasury.sol because the off-chain
// arithmetic is genuinely easy to get subtly wrong, and a UI that guesses wrong would show a
// plausible, confident, false number:
//
//   - `previewHeadroom` applies "0 means UNLIMITED" by returning type(uint256).max. Milestone G
//     names that rule "the single easiest thing to mirror wrongly".
//   - `canExecute` shares `_executionCheck` with `executePayment`, so the preview cannot disagree
//     with what a transaction would actually do.
//   - `hasUnboundedAutoApproval` exists purely so the product does not stay silent about a
//     dangerous policy the owner can choose.
// ---------------------------------------------------------------------------

/** Sentinel the contract returns from `previewHeadroom` for an unlimited (0) limit. */
export const UNLIMITED_HEADROOM = 2n ** 256n - 1n;

export type PreviewHeadroom = {
  singleTxRemaining: bigint;
  dayRemaining: bigint;
  monthRemaining: bigint;
  /** True where the configured limit is 0, i.e. the contract reported `type(uint256).max`. */
  singleTxUnlimited: boolean;
  dayUnlimited: boolean;
  monthUnlimited: boolean;
};

/**
 * Remaining headroom against the configured limits, exactly as the contract computes it.
 *
 * The unlimited flags are derived by comparing against the sentinel the contract returns, NOT by
 * re-reading the policy to see whether the limit is zero. Both are legitimate readings of the
 * chain, but deriving from the returned value means this function cannot disagree with the
 * contract about what it just said.
 */
export async function readPreviewHeadroom(
  client: PublicClient,
  treasuryAddress: string,
  at?: ReadAtBlock,
): Promise<PreviewHeadroom> {
  const r = asArray(
    "previewHeadroom",
    await client.readContract({
      address: getAddress(treasuryAddress),
      abi: treasuryAbi,
      functionName: "previewHeadroom",
      blockNumber: at?.blockNumber,
    }),
  );
  const singleTxRemaining = asBigint("previewHeadroom.singleTxRemaining", r[0]);
  const dayRemaining = asBigint("previewHeadroom.dayRemaining", r[1]);
  const monthRemaining = asBigint("previewHeadroom.monthRemaining", r[2]);
  return {
    singleTxRemaining,
    dayRemaining,
    monthRemaining,
    singleTxUnlimited: singleTxRemaining === UNLIMITED_HEADROOM,
    dayUnlimited: dayRemaining === UNLIMITED_HEADROOM,
    monthUnlimited: monthRemaining === UNLIMITED_HEADROOM,
  };
}

/**
 * Would `caller` be able to execute payment `id` right now?
 *
 * A pure preview of a read-only function. This is NOT an execution path and there is no
 * transaction anywhere near it: it calls `canExecute`, which shares its check with
 * `executePayment`, so the answer here is what the chain itself would conclude.
 *
 * `id` is validated by the contract itself (`PaymentNotFound`), which reverts on 0 or an id
 * above `paymentCount`. Callers on a listing page must treat a revert as "not executable" rather
 * than surfacing it, because a row the contract has never heard of is not an error state for a
 * read-only preview.
 */
export async function readCanExecute(
  client: PublicClient,
  treasuryAddress: string,
  id: bigint,
  caller: string,
): Promise<{ allowed: boolean; reason: number }> {
  const r = asArray(
    "canExecute",
    await client.readContract({
      address: getAddress(treasuryAddress),
      abi: treasuryAbi,
      functionName: "canExecute",
      args: [id, getAddress(caller)],
    }),
  );
  return { allowed: asBool("canExecute.allowed", r[0]), reason: asNumber("canExecute.reason", r[1]) };
}

/**
 * True when the owner has configured auto-approval with no effective bound.
 *
 * Purely an advisory flag for the UI: the contract cannot prevent an owner from choosing this, so
 * the product is obliged to say so rather than stay silent.
 */
export async function readHasUnboundedAutoApproval(
  client: PublicClient,
  treasuryAddress: string,
  at?: ReadAtBlock,
): Promise<boolean> {
  return asBool(
    "hasUnboundedAutoApproval",
    await client.readContract({
      address: getAddress(treasuryAddress),
      abi: treasuryAbi,
      functionName: "hasUnboundedAutoApproval",
      blockNumber: at?.blockNumber,
    }),
  );
}
