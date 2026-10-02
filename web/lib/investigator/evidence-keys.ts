/**
 * Grounding: derive the set of REAL evidence keys from the evidence object itself.
 *
 * This is the mechanism that makes "no unsupported factual claim" enforceable rather than
 * aspirational. A citation is accepted only if it resolves to an actual path in the object
 * that was sent to the model. A finding citing `someFactThatDoesNotExist` cannot be
 * distinguished from a real one by inspecting prose, but it is trivially detectable by
 * checking the path — so that is what we check.
 *
 * Two addressing forms are produced for arrays of identified objects:
 *   checks[0].actualBaseUnits   positional
 *   checks.SINGLE_TX_LIMIT.actualBaseUnits   by the object's own `id`
 * The second is a derived alias over the SAME data, not an invented key.
 */

export type EvidenceKeySet = {
  /** Every path a finding may cite. */
  keys: Set<string>;
  /** Sorted array form, for the prompt and for diagnostics. */
  list: string[];
};

function pushKey(set: Set<string>, path: string): void {
  set.add(path);
}

/**
 * Walks the evidence and records every addressable leaf.
 *
 * Objects with a string `id` get their children additionally exposed under `id.<leaf>`, which
 * is how a human-readable citation such as `checks.DAILY_LIMIT.actualBaseUnits` can be
 * checked rather than guessed at.
 */
export function deriveEvidenceKeys(evidence: unknown): EvidenceKeySet {
  const keys = new Set<string>();
  walk(evidence, "", keys);
  return { keys, list: [...keys].sort() };
}

function walk(node: unknown, path: string, keys: Set<string>): void {
  if (node === null || typeof node !== "object") {
    if (path) pushKey(keys, path);
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      walk(child, childPath, keys);
      // Expose identified array members by their id as well, e.g.
      //   checks[4].limitBaseUnits   and   checks[SINGLE_TX_LIMIT].limitBaseUnits
      // Both address the same data; the alias is derived, never invented.
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        const id = (child as Record<string, unknown>).id;
        if (typeof id === "string" && id.length > 0) {
          for (const leaf of descendantLeaves(child)) {
            const sep = leaf.startsWith("[") ? "" : ".";
            // Both addressing forms are exposed, because both are how humans naturally write
            // a citation and both name the same real data:
            //   checks[SINGLE_TX_LIMIT].limitBaseUnits
            //   checks.SINGLE_TX_LIMIT.limitBaseUnits
            pushKey(keys, `${path}[${id}]${sep}${leaf}`);
            pushKey(keys, `${path}.${id}${sep}${leaf}`);
          }
        }
      }
    });
    return;
  }

  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const childPath = path ? `${path}.${key}` : key;
    const child = record[key];
    if (child !== null && typeof child === "object") {
      walk(child, childPath, keys);
    } else {
      pushKey(keys, childPath);
    }
  }
}

/** Dotted/bracketed suffixes of a node's leaves, relative to the node. */
function descendantLeaves(node: object): string[] {
  const out: string[] = [];
  const collect = (n: unknown, path: string): void => {
    if (n === null || typeof n !== "object") {
      if (path) out.push(path);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach((c, i) => collect(c, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      collect(v, path ? `${path}.${k}` : k);
    }
  };
  collect(node, "");
  return out;
}

/** True when `key` names a real path in the evidence. */
export function isGrounded(key: string, allowed: EvidenceKeySet): boolean {
  return allowed.keys.has(key);
}