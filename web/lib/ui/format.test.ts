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
  formatIsoDate,
  formatLatency,
  formatPercent,
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