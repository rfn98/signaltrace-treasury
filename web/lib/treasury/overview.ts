/**
 * Milestone J — treasury overview view model.
 *
 * SERVER ONLY (`import "server-only"`). This is the only module that knows how to assemble the
 * overview, and it is assembled from chain reads plus display metadata. It is a view model, not a
 * policy engine: nothing here decides whether a payment would be allowed, and nothing here
 * re-implements a limit check.
 *
 * CHAIN IS THE AUTHORITY, and the split is per-field rather than per-module:
 *
 *   - balance, policy limits, paused, counters, usage, unbounded-auto-approval  -> chain
 *   - asset symbol/name and the explorer base URL                                -> DB index
 *   - policy limits and usage are read from the contract's own `previewHeadroom` /
 *     `currentUsage`, never recomputed in TypeScript, so the "0 means UNLIMITED" rule and the
 *     reserved+spent summation cannot drift from Treasury.sol.
 *
 * The display metadata read from the database is labelled and link-only. It is never allowed to
 * supply a number that appears in a policy decision.
 */
import "server-only";

import {
  createReadClient,
  readChainSnapshot,
  readCurrentCommitted,
  readHasUnboundedAutoApproval,
  readPreviewHeadroom,
  resolveRpcUrl,
} from "@/lib/chain/adapter";
import { monthKeyToYearMonth } from "@/lib/policy/calendar";
import { CHAIN_ID, TREASURY_ADDRESS } from "@/lib/policy/types";
import { getTreasuryByChain } from "@/lib/queries";
import { usageTone } from "@/lib/ui/status";
import type { PolicyLimitView, TreasuryOverview, UsageView } from "./types";

/** Default RPC endpoint, overridable. A Server Component reads the same env the API route does. */
function rpcUrl(): string {
  return resolveRpcUrl();
}

/**
 * Builds a limit view.
 *
 * `zeroMeans` is passed in rather than assumed, because Treasury.sol uses 0 for two opposite
 * things and only the caller knows which limit it is describing. `contractSaysUnlimited` comes
 * straight from the contract's own `previewHeadroom`, which is the authority on the question.
 */
export function limitView(
  id: string,
  label: string,
  limit: bigint,
  zeroMeans: PolicyLimitView["zeroMeans"],
  contractSaysUnlimited?: boolean,
): PolicyLimitView {
  const unlimited = zeroMeans === "UNLIMITED" && (contractSaysUnlimited ?? limit === 0n);
  return {
    id,
    label,
    limit: limit.toString(),
    zeroMeans,
    unlimited,
    // For auto-approve, 0 is not a missing ceiling — it is a deliberate refusal to let the engine
    // settle anything unattended. Labelling that "unlimited" would invert the control entirely.
    disabled: zeroMeans === "DISABLED" && limit === 0n,
  };
}

/**
 * Percentage for a meter, as an integer 0-100, computed entirely in BigInt.
 *
 * Returns null when the limit is unlimited so no bar is drawn at all: rendering "100% of
 * infinity" as a full bar is exactly the kind of confident, false visual this project refuses to
 * produce. A ratio above the limit is clamped to 100 because the bar represents "at or past the
 * ceiling", and the tone carries the distinction.
 */
export function meterPercent(committed: bigint, limit: bigint, unlimited: boolean): number | null {
  if (unlimited || limit === 0n) return null;
  const tenths = (committed * 1000n) / limit;
  const clamped = tenths > 1000n ? 1000n : tenths;
  return Number(clamped / 10n);
}

export function usageView(
  bucket: UsageView["bucket"],
  committed: bigint,
  limit: bigint,
  remaining: bigint | null,
  unlimited: boolean,
  bucketLabel: string,
): UsageView {
  return {
    bucket,
    committed: committed.toString(),
    limit: limit.toString(),
    unlimited,
    remaining: unlimited ? null : (remaining ?? 0n).toString(),
    usedPercent: meterPercent(committed, limit, unlimited),
    tone: usageTone(committed, limit),
    bucketLabel,
  };
}

/**
 * Reads the whole overview, at ONE block.
 *
 * The snapshot is read first to establish a block number, and every other chain read is then
 * pinned to that same block. Without the pin, a balance from block N could sit above a limit read
 * at block N+1, and the page would confidently report a relationship between two observations that
 * never coexisted. The cost is one extra round trip; the benefit is that `observedAtBlock` means
 * what it says.
 *
 * Display metadata is best-effort: if the database is unreachable the panel still renders with
 * whatever the chain says, with the index-sourced fields marked unavailable, because the
 * authoritative numbers do not depend on it. A missing chain, by contrast, is an error — there
 * would be nothing true to show.
 */
export async function loadTreasuryOverview(
  treasuryAddress: string = TREASURY_ADDRESS,
): Promise<TreasuryOverview> {
  const client = createReadClient(rpcUrl());

  const snapshot = await readChainSnapshot(client, treasuryAddress);
  const at = { blockNumber: snapshot.blockNumber };

  const [committed, headroom, unboundedAutoApproval, indexed] = await Promise.all([
    readCurrentCommitted(client, treasuryAddress, at),
    readPreviewHeadroom(client, treasuryAddress, at),
    readHasUnboundedAutoApproval(client, treasuryAddress, at),
    // Never allowed to fail the read: it supplies a symbol and an explorer URL, nothing more.
    getTreasuryByChain(CHAIN_ID).catch(() => null),
  ]);

  const policy = snapshot.policy;

  const usage: UsageView[] = [
    usageView(
      "day",
      committed.dayCommitted,
      policy.dailyLimit,
      headroom.dayRemaining,
      headroom.dayUnlimited,
      `Day ${committed.dayKey.toString()}`,
    ),
    usageView(
      "month",
      committed.monthCommitted,
      policy.monthlyLimit,
      headroom.monthRemaining,
      headroom.monthUnlimited,
      monthKeyToYearMonth(committed.monthKey),
    ),
  ];

  return {
    network: {
      chainId: snapshot.chainId,
      name: indexed?.chain?.name ?? "Arbitrum Sepolia",
      nativeSymbol: indexed?.chain?.nativeSymbol ?? "ETH",
      explorerBaseUrl: indexed?.chain?.explorerBaseUrl ?? "https://sepolia.arbiscan.io",
    },
    asset: {
      // The token ADDRESS is read from the contract, never from our config: the balance is read
      // from the token the treasury actually holds.
      address: snapshot.assetAddress,
      symbol: indexed?.asset?.symbol ?? "mUSD",
      name: indexed?.asset?.name ?? "Mock USD",
      decimals: snapshot.assetDecimals,
    },
    treasury: {
      address: snapshot.treasuryAddress,
      // Owner and agent are displayed from the index as CONFIGURATION. They are never treated as
      // authority here; anything role-dependent is read from the chain at the point of use.
      ownerAddress: indexed?.ownerAddress ?? "—",
      agentAddress: indexed?.agentAddress ?? "—",
      paused: snapshot.counters.paused,
      sources: {
        address: "chain",
        // Authority: the contract decides whether the treasury is accepting payments.
        paused: "chain",
        // Display only, and labelled as such rather than being quietly promoted to authority.
        ownerAddress: indexed?.ownerAddress ? "index" : "unavailable",
        agentAddress: indexed?.agentAddress ? "index" : "unavailable",
      },
    },
    balance: snapshot.counters.balance.toString(),
    policy: {
      singleTxLimit: limitView("singleTxLimit", "Single transaction", policy.singleTxLimit, "UNLIMITED"),
      dailyLimit: limitView(
        "dailyLimit",
        "Daily",
        policy.dailyLimit,
        "UNLIMITED",
        headroom.dayUnlimited,
      ),
      monthlyLimit: limitView(
        "monthlyLimit",
        "Monthly",
        policy.monthlyLimit,
        "UNLIMITED",
        headroom.monthUnlimited,
      ),
      // Inverted meaning: 0 here means auto-approval is switched off, not that the ceiling is gone.
      autoApproveLimit: limitView(
        "autoApproveLimit",
        "Auto-approve up to",
        policy.autoApproveLimit,
        "DISABLED",
      ),
      allowUnknownRecipients: policy.allowUnknownRecipients,
    },
    usage,
    counters: {
      lifetimeReserved: snapshot.counters.lifetimeReserved.toString(),
      lifetimeSpent: snapshot.counters.lifetimeSpent.toString(),
      paymentCount: Number(snapshot.paymentCount),
    },
    unboundedAutoApproval,
    observedAtBlock: snapshot.blockNumber.toString(),
    observedAtTimestamp: snapshot.blockTimestamp.toString(),
  };
}