/**
 * Milestone J — display formatting tests.
 *
 * Formatting is where a treasury console quietly starts lying: a rounded amount, a truncated hash
 * that cannot be recovered, or a percentage computed through a float. These tests pin the
 * behaviour that prevents each of those.
 */
import { describe, expect, it } from "vitest";

import {
  explorerUrl,
  formatAmount,
  formatBlock,
  formatDayLabel,
  formatIsoDate,
  formatLatency,
  formatMonthLabel,
  formatPercent,
  formatPolicyMonthLabel,
  formatTimestamp,
  shortAddress,
  shortHash,
} from "@/lib/ui/format";

describe("shortAddress", () => {
  it("elides the middle and keeps both ends", () => {
    const address = "0xD14e45a90A8b8F603db5Ed21B34Fc947D1bD88E9";
    const short = shortAddress(address);
    expect(short.startsWith("0xD14e")).toBe(true);
    // Four trailing characters are kept, so the tail is "88E9" — the full address ends "…D88E9".
    expect(short.endsWith("88E9")).toBe(true);
    expect(short).toBe("0xD14e…88E9");
    expect(short.length).toBeLessThan(address.length);
  });

  it("keeps the recoverable value available to the reader", () => {
    // A truncated identifier that cannot be recovered is not evidence. Components render the full
    // value in a title attribute; this asserts the two ends are always distinguishable.
    const a = shortAddress("0x1111111111111111111111111111111111111111");
    const b = shortAddress("0x1111111111111111111111111111111111111112");
    expect(a).not.toBe(b);
  });

  it("renders a dash for absent values rather than an empty cell", () => {
    expect(shortAddress(null)).toBe("—");
    expect(shortAddress(undefined)).toBe("—");
    expect(shortAddress("")).toBe("—");
  });

  it("does not mangle a short value", () => {
    expect(shortAddress("0xabc")).toBe("0xabc");
  });
});

describe("shortHash", () => {
  it("keeps a longer prefix than an address for a hash", () => {
    const hash = "0x5e8669878636481b162077ecf2f22f5fdc5e1284baedaf9409b1422a9d077373";
    const short = shortHash(hash);
    expect(short).toContain("…");
    expect(short.startsWith("0x5e8669")).toBe(true);
  });

  it("renders a dash for absent values", () => {
    expect(shortHash(null)).toBe("—");
  });
});

describe("formatAmount", () => {
  it("uses the chain-supplied decimals", () => {
    expect(formatAmount(10_000_000n, 6, "mUSD")).toBe("10.000000 mUSD");
    expect(formatAmount(1_000_000_000n, 6, "mUSD")).toBe("1000.000000 mUSD");
  });

  it("is lossless for the live seed amounts", () => {
    // The two demo payments, exactly as they sit on chain.
    expect(formatAmount(10_000_000n, 6, "mUSD")).toBe("10.000000 mUSD");
    expect(formatAmount(50_000_000n, 6, "mUSD")).toBe("50.000000 mUSD");
  });

  it("accepts the decimal strings that cross the JSON boundary", () => {
    expect(formatAmount("50000000", 6, "mUSD")).toBe("50.000000 mUSD");
  });

  it("handles zero decimals and absent values", () => {
    expect(formatAmount(42n, 0, "UNIT")).toBe("42 UNIT");
    expect(formatAmount(null, 6, "mUSD")).toBe("—");
  });

  it("never loses a fractional base unit", () => {
    expect(formatAmount(1n, 6, "mUSD")).toBe("0.000001 mUSD");
  });
});

describe("formatPercent", () => {
  it("computes in integers so the ratio cannot drift through a float", () => {
    expect(formatPercent(1n, 3n)).toBe("33.3%");
    expect(formatPercent(1n, 2n)).toBe("50.0%");
    expect(formatPercent(0n, 100n)).toBe("0.0%");
  });

  it("refuses to divide by zero rather than reporting Infinity", () => {
    expect(formatPercent(0n, 0n)).toBe("—");
  });
});

describe("formatBlock and timestamps", () => {
  it("renders block numbers as plain integers", () => {
    expect(formatBlock(314762287n)).toBe("314762287");
    expect(formatBlock("314303123")).toBe("314303123");
    expect(formatBlock(null)).toBe("—");
  });

  it("renders UTC only, so a demo is never ambiguous about the timezone", () => {
    // Pinned against the formatter rather than a hand-computed calendar date: the property under
    // test is the trailing "Z" and the 24-hour clock, both of which a local-time render breaks.
    const rendered = formatTimestamp(1790773987n);
    expect(rendered).toBe("2026-09-30T13:13:07Z");
    expect(rendered.endsWith("Z")).toBe(true);
    expect(rendered).toBe(new Date(Number(1790773987n) * 1000).toISOString().replace(".000Z", "Z"));
  });

  it("renders ISO timestamps for indexed rows", () => {
    expect(formatIsoDate("2026-10-02T00:33:07.000Z")).toBe("2026-10-02 00:33:07Z");
    expect(formatIsoDate(new Date("2026-10-02T00:33:07Z"))).toBe("2026-10-02 00:33:07Z");
    expect(formatIsoDate(null)).toBe("—");
    expect(formatIsoDate("not a date")).toBe("—");
  });
});

describe("formatLatency", () => {
  it("switches units at one second", () => {
    expect(formatLatency(1)).toBe("1 ms");
    expect(formatLatency(999)).toBe("999 ms");
    expect(formatLatency(1500)).toBe("1.5 s");
    expect(formatLatency(null)).toBe("—");
  });
});

describe("formatDayLabel / formatMonthLabel", () => {
  // 2026-10-02T12:00:00Z, the observed-block timestamp these labels are formatted from.
  const october = 1790942400n;

  it("names the day in a form a reader can place on a calendar", () => {
    expect(formatDayLabel(october)).toBe("Day · Oct 2, 2026");
  });

  it("names the month in a form a reader can place on a calendar", () => {
    expect(formatMonthLabel(october)).toBe("Month · October 2026");
  });

  it("reads the same calendar day regardless of the hour, because the chain reports UTC", () => {
    const justAfterMidnight = BigInt(Math.floor(Date.UTC(2026, 9, 2, 0, 0, 1) / 1000));
    const justBeforeMidnight = BigInt(Math.floor(Date.UTC(2026, 9, 2, 23, 59, 59) / 1000));
    expect(formatDayLabel(justAfterMidnight)).toBe("Day · Oct 2, 2026");
    expect(formatDayLabel(justBeforeMidnight)).toBe("Day · Oct 2, 2026");
  });

  it("does not roll the label forward a day early in a negative-offset timezone", () => {
    // 2026-10-02T00:30:00Z is still October 1 in any zone west of UTC-1. Pinning to UTC means a
    // reviewer in New York and one in Berlin are reading about the same day the chain recorded.
    const justAfterMidnightUtc = BigInt(Math.floor(Date.UTC(2026, 9, 2, 0, 30) / 1000));
    expect(formatDayLabel(justAfterMidnightUtc)).toBe("Day · Oct 2, 2026");
  });

  it("shows an absent value as a dash rather than inventing a date", () => {
    expect(formatDayLabel(null)).toBe("Day · —");
    expect(formatMonthLabel(undefined)).toBe("Month · —");
    expect(formatDayLabel("not-a-number")).toBe("Day · —");
  });
});

describe("formatPolicyMonthLabel", () => {
  it("names the contract's monthKey as a policy month", () => {
    // 24321 = 2026 * 12 + 9, the bucket both demo payments were reserved in.
    expect(formatPolicyMonthLabel(24321n)).toBe("Policy month · September 2026");
  });

  it("decodes the December edge case rather than rolling into the next January", () => {
    // monthKey 2026 * 12 + 12. Naive floor division calls this month 0 of 2027.
    expect(formatPolicyMonthLabel(2026n * 12n + 12n)).toBe("Policy month · December 2026");
    expect(formatPolicyMonthLabel(2026n * 12n + 1n)).toBe("Policy month · January 2026");
  });

  it("admits an absent key instead of inventing a month", () => {
    expect(formatPolicyMonthLabel(null)).toBe("Policy month · —");
    expect(formatPolicyMonthLabel(undefined)).toBe("Policy month · —");
  });

  it("rejects a key that is not a real month", () => {
    // A month number outside 1..12 cannot come from the contract, and must not be rendered as if
    // it could. `monthKeyToYearMonth` cannot produce one, so this covers a hand-built value.
    expect(formatPolicyMonthLabel(0n)).toBe("Policy month · —");
  });

  it("is presentation only: the same key always names the same month", () => {
    const key = 24321n;
    expect(formatPolicyMonthLabel(key)).toBe(formatPolicyMonthLabel(key));
  });
});

describe("explorerUrl", () => {
  it("builds address and transaction links from the indexed base", () => {
    const base = "https://sepolia.arbiscan.io";
    expect(explorerUrl(base, "address", "0xabc")).toBe("https://sepolia.arbiscan.io/address/0xabc");
    expect(explorerUrl(base, "tx", "0xdef")).toBe("https://sepolia.arbiscan.io/tx/0xdef");
  });

  it("tolerates a trailing slash", () => {
    expect(explorerUrl("https://sepolia.arbiscan.io/", "tx", "0xdef")).toBe(
      "https://sepolia.arbiscan.io/tx/0xdef",
    );
  });

  it("returns null rather than a dead link", () => {
    expect(explorerUrl(null, "tx", "0xdef")).toBeNull();
    expect(explorerUrl("https://sepolia.arbiscan.io", "tx", null)).toBeNull();
    expect(explorerUrl("not-a-url", "tx", "0xdef")).toBeNull();
  });
});