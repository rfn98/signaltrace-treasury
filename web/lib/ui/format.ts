/**
 * Milestone J — display formatting.
 *
 * Pure string helpers for rendering values that the rest of the stack keeps as lossless
 * base-unit integers. Every function here is display-only and none of them may be used to
 * compute a verdict.
 *
 * The project's monetary rule — bigint base units everywhere, `formatBaseUnits` for display —
 * is established in `lib/json.ts`. This module only adds the presentation concerns that
 * `formatBaseUnits` does not cover: shortening an address or a hash for a dense table, and
 * building an explorer link. The full value is always available (via `title`), because a
 * truncated identifier that cannot be recovered is not evidence.
 */
import { formatBaseUnits } from "@/lib/json";

/**
 * Shortens an address for a dense table: `0xD14e45a9…ACF947D1`.
 *
 * Symmetric truncation, because a reader must be able to tell two nearby addresses apart. The
 * leading `0x` and the first/last four hex characters are kept; the middle is elided.
 */
export function shortAddress(address: string | null | undefined, edge = 4): string {
  if (!address) return "—";
  const body = address.startsWith("0x") ? address.slice(2) : address;
  if (body.length <= edge * 2 + 2) return address;
  return `0x${body.slice(0, edge)}…${body.slice(-edge)}`;
}

/** Shortens a tx hash: `0x5e866987…d077373`. Same contract as `shortAddress`. */
export function shortHash(hash: string | null | undefined, edge = 6): string {
  return shortAddress(hash, edge);
}

/**
 * Renders base units with the asset symbol, using the decimals read from the CHAIN.
 *
 * `decimals` is a parameter rather than a constant because the value comes from
 * `ChainSnapshot.assetDecimals`, which is read from the deployed contract. Hardcoding 6 would be
 * a second source of truth for a monetary assumption.
 */
export function formatAmount(
  baseUnits: bigint | string | null | undefined,
  decimals: number,
  symbol: string,
): string {
  if (baseUnits === null || baseUnits === undefined) return "—";
  const value = typeof baseUnits === "string" ? BigInt(baseUnits) : baseUnits;
  return `${formatBaseUnits(value, decimals)} ${symbol}`;
}

/** Renders a percentage with no false precision: one decimal place, or "—" if not finite. */
export function formatPercent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "—";
  // 0-100 scale in tenths, computed in integers so the ratio cannot drift through a float.
  const tenths = (part * 1000n) / whole;
  const wholePct = tenths / 10n;
  const frac = (tenths % 10n).toString();
  return `${wholePct.toString()}.${frac}%`;
}

/** Renders a block number as a plain integer. */
export function formatBlock(block: bigint | string | null | undefined): string {
  if (block === null || block === undefined) return "—";
  return block.toString();
}

/** Renders a unix timestamp (seconds) as an ISO UTC string. No local time, no ambiguity. */
export function formatTimestamp(seconds: bigint | string | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Renders an ISO string or Date as a short UTC stamp for a dense table. */
export function formatIsoDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 19).replace("T", " ") + "Z";
}

/** Renders a duration in milliseconds for the investigator diagnostics row. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Builds an explorer URL from the base recorded in the database `Chain` row.
 *
 * The base URL is indexed display metadata, never authority: it is a link, not a fact about
 * money. A malformed or absent base yields `null` so the component renders plain text instead of
 * a dead link.
 */
export function explorerUrl(
  baseUrl: string | null | undefined,
  kind: "address" | "tx",
  value: string | null | undefined,
): string | null {
  if (!baseUrl || !value) return null;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) return null;
  return `${trimmed}/${kind}/${value}`;
}