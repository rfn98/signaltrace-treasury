import { describe, expect, it } from "vitest";
import { canonicalJson, evidenceHash } from "@/lib/evidence/canonical";

describe("canonicalJson", () => {
  it("sorts object keys so insertion order cannot change the digest", () => {
    const a = { b: 2, a: 1, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 1, b: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":1,"b":2,"c":{"y":2,"z":1}}');
  });

  it("renders bigint as a lossless decimal string", () => {
    expect(canonicalJson({ v: 10_000_000n })).toBe('{"v":"10000000"}');
    // A value beyond 2^53 must not become a float.
    const huge = 123456789012345678901234567890n;
    expect(canonicalJson({ v: huge })).toBe(`{"v":"${huge.toString()}"}`);
  });

  it("renders Date as ISO and throws on an invalid Date", () => {
    expect(canonicalJson({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
    expect(() => canonicalJson({ d: new Date("nope") })).toThrow(/invalid Date/);
  });

  it("preserves array order (position is data)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined keys so {a:undefined} and {} agree", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("throws on a top-level undefined rather than silently emitting nothing", () => {
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
  });

  it("normalises -0 to 0 so signed zero has one digest", () => {
    expect(canonicalJson({ z: -0 })).toBe(canonicalJson({ z: 0 }));
  });

  it("throws on non-finite numbers instead of emitting null", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });
});

describe("evidenceHash", () => {
  it("is stable across key order and prefixes the algorithm", () => {
    const h1 = evidenceHash({ a: 1, b: 2n });
    const h2 = evidenceHash({ b: 2n, a: 1 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when any value changes", () => {
    const base = evidenceHash({ amount: 10n, to: "0xabc" });
    expect(evidenceHash({ amount: 11n, to: "0xabc" })).not.toBe(base);
    expect(evidenceHash({ amount: 10n, to: "0xabd" })).not.toBe(base);
  });
});
