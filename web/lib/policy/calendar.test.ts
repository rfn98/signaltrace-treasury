import { describe, expect, it } from "vitest";
import { dayIndex, monthKey, monthKeyToYearMonth, civilFromTimestamp } from "@/lib/policy/calendar";

/**
 * The bucket arithmetic has to agree with the contract exactly, because the day and month
 * limits are keyed on these values. A one-day drift would silently move every payment into
 * a different budget bucket and produce a wrong limit verdict.
 *
 * The Milestone E transactions are the ground truth: they were created on-chain and the
 * contract stamped dayIndex 20726 / monthKey 24321, which this must reproduce from their
 * block timestamps.
 */

const E_CREATED_AT = 1_790_773_987n; // payment 1, block 314303123
const E_CREATED_AT_2 = 1_790_773_994n; // payment 2, block 314303149

describe("calendar mirror", () => {
  it("reproduces the contract's dayIndex for the Milestone E block timestamps", () => {
    expect(dayIndex(E_CREATED_AT)).toBe(20726n);
    expect(dayIndex(E_CREATED_AT_2)).toBe(20726n);
  });

  it("reproduces the contract's monthKey for the Milestone E block timestamps", () => {
    expect(monthKey(E_CREATED_AT)).toBe(24321n);
    expect(monthKey(E_CREATED_AT_2)).toBe(24321n);
  });

  it("derives the same civil month the contract recorded", () => {
    const { year, month } = civilFromTimestamp(E_CREATED_AT);
    // 2026-10: monthKey = 2026*12 + 10
    expect(year * 12n + month).toBe(24321n);
  });

  it("labels a monthKey as YYYY-MM", () => {
    // monthKey is year*12 + month with a ONE-based month, so 24321 = 2026*12 + 9 = 2026-09.
    // (The inverse is unique: months run 1..12, so consecutive years never collide.)
    expect(monthKeyToYearMonth(24321n)).toBe("2026-09");
    expect(monthKeyToYearMonth(1970n * 12n + 1n)).toBe("1970-01");
    expect(monthKeyToYearMonth(2024n * 12n + 12n)).toBe("2024-12");
  });

  it("round-trips every month of several years through the label (regression: December)", () => {
    // December is the case that broke a naive floor-division inverse, so every month is
    // checked rather than just the one that happened to fail.
    for (const year of [1970n, 1999n, 2024n, 2025n, 2026n, 2100n]) {
      for (let month = 1n; month <= 12n; month++) {
        const key = year * 12n + month;
        expect(monthKeyToYearMonth(key)).toBe(
          `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`,
        );
      }
    }
  });

  it("handles a leap day (2024-02-29) without drifting", () => {
    const leapDay = BigInt(Math.floor(Date.UTC(2024, 1, 29) / 1000));
    expect(civilFromTimestamp(leapDay)).toEqual({ year: 2024n, month: 2n });
  });

  it("handles the Unix epoch itself", () => {
    expect(civilFromTimestamp(0n)).toEqual({ year: 1970n, month: 1n });
    expect(dayIndex(0n)).toBe(0n);
    expect(monthKey(0n)).toBe(1970n * 12n + 1n);
  });

  it("increments the day at exactly midnight UTC", () => {
    const lastSecondOfDay = 86400n * 20726n - 1n;
    const firstSecondOfDay = 86400n * 20726n;
    expect(dayIndex(lastSecondOfDay)).toBe(20725n);
    expect(dayIndex(firstSecondOfDay)).toBe(20726n);
  });
});
