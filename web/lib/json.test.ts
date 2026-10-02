import { describe, expect, it } from "vitest";
import { formatBaseUnits, toJsonSafe } from "./json";

describe("toJsonSafe", () => {
  it("renders a BigInt as a decimal string instead of throwing", () => {
    // JSON.stringify throws on a raw BigInt, which is the failure mode this guards.
    expect(() => JSON.stringify({ amount: 10_000_000n })).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(toJsonSafe({ amount: 10_000_000n })))).toEqual({
      amount: "10000000",
    });
  });

  it("does not lose precision on values beyond Number.MAX_SAFE_INTEGER", () => {
    // 2^63 - 1 exceeds Number.MAX_SAFE_INTEGER (2^53 - 1); a float64 round-trip
    // would corrupt this, a string round-trip cannot.
    const huge = 9223372036854775807n;
    const roundTripped = toJsonSafe({ v: huge });
    expect(typeof roundTripped.v).toBe("string");
    expect(BigInt(roundTripped.v as string)).toBe(huge);
  });

  it("preserves exact base-unit amounts for the seeded payments", () => {
    const rows = toJsonSafe([{ a: 10_000_000n }, { a: 50_000_000n }]);
    expect(rows.map((r) => BigInt(r.a as string))).toEqual([10_000_000n, 50_000_000n]);
  });

  it("converts nested BigInts and Dates", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(toJsonSafe({ p: { amount: 7n, at: d } })).toEqual({
      p: { amount: "7", at: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("passes through primitives, null and booleans untouched", () => {
    expect(toJsonSafe({ s: "x", n: 1, b: true, z: null })).toEqual({
      s: "x",
      n: 1,
      b: true,
      z: null,
    });
  });
});

describe("formatBaseUnits", () => {
  it("renders mUSD base units with 6 decimals", () => {
    expect(formatBaseUnits(10_000_000n, 6)).toBe("10.000000");
    expect(formatBaseUnits(50_000_000n, 6)).toBe("50.000000");
  });

  it("handles sub-unit and zero values", () => {
    expect(formatBaseUnits(0n, 6)).toBe("0.000000");
    expect(formatBaseUnits(1n, 6)).toBe("0.000001");
    expect(formatBaseUnits(1_234_567n, 6)).toBe("1.234567");
  });

  it("handles 0-decimal assets", () => {
    expect(formatBaseUnits(42n, 0)).toBe("42");
  });
});
