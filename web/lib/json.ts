/**
 * JSON helpers for Prisma BigInt columns.
 *
 * Every monetary value in this project is a BigInt base-unit integer. `JSON.stringify`
 * throws "TypeError: Do not know how to serialize a BigInt" on a raw BigInt, so any
 * route or script returning Prisma rows must convert explicitly. We return decimal
 * STRINGS rather than JS numbers: a JS number cannot hold the full uint64 range and
 * would silently lose precision on large base-unit amounts.
 *
 * A string is also unambiguous to a consumer: 10000000n and 10000000 are rendered
 * identically here, but only the first one is provably lossless.
 */
export type JsonSafe<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends object
      ? { [K in keyof T]: JsonSafe<T[K]> }
      : T;

/** Recursively converts BigInt to a decimal string and Date to an ISO string. */
export function toJsonSafe<T>(value: T): JsonSafe<T> {
  if (typeof value === "bigint") return value.toString() as JsonSafe<T>;
  if (value instanceof Date) return value.toISOString() as JsonSafe<T>;
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v)) as JsonSafe<T>;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out as JsonSafe<T>;
  }
  return value as JsonSafe<T>;
}

/** Renders base units as a human-readable decimal string. Display only, never persisted. */
export function formatBaseUnits(baseUnits: bigint, decimals: number): string {
  if (decimals < 0) throw new RangeError("decimals must be non-negative");
  const base = 10n ** BigInt(decimals);
  const whole = baseUnits / base;
  const fraction = (baseUnits % base).toString().padStart(decimals, "0");
  return decimals === 0 ? whole.toString() : `${whole}.${fraction}`;
}
