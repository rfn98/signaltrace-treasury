import { createHash } from "node:crypto";

/**
 * Deterministic canonical serialisation for evidence hashing.
 *
 * An evidence hash is only worth anything if two parties holding equivalent evidence
 * compute the same digest. Plain `JSON.stringify` cannot promise that:
 *
 *   - object key order follows insertion order, which differs between two objects that
 *     are semantically identical,
 *   - `JSON.stringify` throws on `bigint` and mangles it if something upstream coerces it,
 *   - `undefined` properties are dropped silently, so `{a: undefined}` and `{}` collide,
 *   - a float like `1.0` and `1` serialise differently while comparing equal in code.
 *
 * `canonicalJson` removes all four by normalising into a single canonical form before
 * serialising, and `evidenceHash` hashes exactly those bytes.
 */

export type Canonical = null | boolean | number | string | Canonical[] | { [k: string]: Canonical };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalise(value: unknown, path: string): Canonical {
  if (value === null) return null;

  switch (typeof value) {
    case "boolean":
      return value;
    case "bigint":
      // Lossless decimal string. Never a JS number: uint256 base-unit amounts do not fit.
      return value.toString(10);
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path} (${String(value)})`);
      }
      // Normalise -0 to 0 so signed and unsigned zero cannot produce two digests.
      return value === 0 ? 0 : value;
    case "undefined":
      throw new TypeError(`canonicalJson: undefined at ${path}; omit the key instead`);
    case "function":
    case "symbol":
      throw new TypeError(`canonicalJson: ${typeof value} at ${path} is not serialisable`);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`canonicalJson: invalid Date at ${path}`);
    }
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    // Order is preserved: array position is data, not a presentation detail.
    return value.map((v, i) => normalise(v, `${path}[${i}]`));
  }

  if (isPlainObject(value)) {
    const out: { [k: string]: Canonical } = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) continue; // absent and explicitly undefined must agree
      out[key] = normalise(child, `${path}.${key}`);
    }
    return out;
  }

  throw new TypeError(`canonicalJson: unsupported value at ${path} (${Object.prototype.toString.call(value)})`);
}

/**
 * Canonical JSON text: recursively key-sorted, `bigint`/`Date` normalised, no whitespace.
 * Stable across key insertion order, Node version and machine.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, "$"));
}

/** Lowercase hex SHA-256 of the canonical form. Prefixed `sha256:` so the algorithm travels with the digest. */
export function evidenceHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
