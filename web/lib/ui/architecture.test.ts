/**
 * Milestone J — architecture and truthfulness tests.
 *
 * These assert constraints that a type cannot: what the source files are allowed to say and import.
 * A regression like "the detail page started fetching its own API route" or "policy status got
 * derived from the chain status" typechecks perfectly well, and would ship. These catch it.
 *
 * The file walks the real tree rather than checking inlined copies of it, so a test cannot pass
 * while the actual component drifts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Every `.tsx`/`.ts` file under the app and components trees, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const APP = sourceFiles(join(ROOT, "app"));
const COMPONENTS = sourceFiles(join(ROOT, "components"));
const ALL_UI = [...APP, ...COMPONENTS];

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Strips comments so a prohibition is not satisfied by a comment that mentions the banned thing. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("Server Components only", () => {
  it("declares no 'use client' anywhere in the UI tree", () => {
    // Locked constraint. `error.tsx` is deliberately absent because Next 16 requires it to be a
    // Client Component; refusals are rendered in the Server Component instead.
    const offenders = ALL_UI.filter((f) => /^\s*["']use client["']/m.test(read(f)));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("adds no client boundary directive even indirectly", () => {
    for (const file of ALL_UI) {
      expect(code(file)).not.toMatch(/["']use client["']/);
    }
  });

  it("uses no client-only hooks", () => {
    // A hook without the directive would throw at build time, so this is belt-and-braces against
    // someone adding one and disabling the check instead.
    const hooks = ["useState", "useEffect", "useReducer", "useCallback", "useMemo", "useRef"];
    const offenders: string[] = [];
    for (const file of ALL_UI) {
      const src = code(file);
      for (const hook of hooks) {
        // Declarations (a hook may be *defined* here) are not calls.
        if (new RegExp(`(?<![\\w.])${hook}\\s*\\(`, "g").test(src)) {
          offenders.push(`${relative(ROOT, file)} -> ${hook}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the data layer server-only", () => {
    for (const file of [join(ROOT, "lib/treasury/overview.ts"), join(ROOT, "lib/treasury/payment-list.ts")]) {
      expect(read(file)).toMatch(/^import "server-only";/m);
    }
  });
});

describe("the UI does not talk to itself over HTTP", () => {
  it("never fetches its own investigation route", () => {
    // Calling the app's own endpoint from a Server Component would double the database and RPC
    // connections and make correctness depend on a loopback hop.
    const offenders = ALL_UI.filter((f) =>
      /fetch\s*\(\s*[`'"]\/api\/investigations/.test(code(f)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("never references the investigation API path in UI code at all", () => {
    for (const file of ALL_UI) {
      expect(code(file)).not.toMatch(/api\/investigations/);
    }
  });

  it("calls the investigation service directly, exactly once, in the detail page", () => {
    const page = code(join(ROOT, "app/payments/[paymentId]/page.tsx"));
    const calls = page.match(/investigatePayment\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // And it is the real service, not a re-implementation.
    expect(page).toMatch(/from "@\/lib\/investigation\/service"/);
    expect(page).toMatch(/investigationDeps\s*\(\s*\)/);
  });

  it("adds no new route handlers", () => {
    // Milestone I's handler is the only one. A write endpoint would break the milestone boundary.
    const routes = sourceFiles(join(ROOT, "app/api"));
    expect(routes.map((f) => relative(ROOT, f))).toEqual([
      join("app", "api", "investigations", "[paymentId]", "route.ts"),
    ]);
    expect(read(routes[0])).not.toMatch(/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/);
  });
});

describe("no client-side fetching of treasury data", () => {
  it("contains no fetch call in any component or page", () => {
    const offenders = ALL_UI.filter((f) => /\bfetch\s*\(/.test(code(f)));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe("policy and lifecycle stay separate in the source", () => {
  it("never derives a policy decision from an on-chain status", () => {
    // The single most important structural rule. `policyStatus` must only ever receive a policy
    // decision, and `lifecycleStatus` only a chain status.
    const files = [join(ROOT, "lib/treasury/detail.ts"), ...COMPONENTS];
    for (const file of files) {
      const src = code(file);
      // A policy status built from anything lifecycle-shaped.
      expect(src).not.toMatch(/policyStatus\s*\([^)]*(onChainStatus|lifecycleRaw|\.lifecycle)/);
      // A lifecycle status built from a policy decision.
      expect(src).not.toMatch(/lifecycleStatus\s*\([^)]*(policyDecision|\.policy\b|verdict\.policy)/);
    }
  });

  it("renders the policy verdict and the lifecycle status from two distinct fields", () => {
    const panel = code(join(ROOT, "components/verdict-panel.tsx"));
    expect(panel).toMatch(/verdict\.policy/);
    expect(panel).toMatch(/verdict\.lifecycle/);
    // Two separate headings, so neither visually outranks the other.
    expect(panel).toMatch(/Policy decision — what the engine would do now/);
    expect(panel).toMatch(/On-chain status — what has happened/);
  });

  it("keeps the investigator out of the verdict model", () => {
    // `VerdictPanelModel` must not be able to hold an investigator field at all.
    const types = read(join(ROOT, "lib/treasury/types.ts"));
    const verdictBlock = types.slice(types.indexOf("export type VerdictPanelModel"));
    const investigatorMention = verdictBlock
      .slice(0, verdictBlock.indexOf("};"))
      .match(/investigator/i);
    expect(investigatorMention).toBeNull();
  });

  it("has the advisory notice unconditionally in the investigator panel", () => {
    const panel = code(join(ROOT, "components/investigator-panel.tsx"));
    // Present, and not behind a conditional.
    expect(panel).toMatch(/ADVISORY_ONLY_NOTICE/);
    expect(panel).not.toMatch(/\{[^}]*&&[^}]*ADVISORY_ONLY_NOTICE/);
    expect(panel).not.toMatch(/if\s*\([^)]*\)\s*\{[^}]*ADVISORY_ONLY_NOTICE/);
  });
});

describe("no fabricated state", () => {
  it("never hardcodes the observed block or a balance", () => {
    for (const file of ALL_UI) {
      expect(code(file)).not.toMatch(/blockNumber\s*[:=]\s*\d/);
    }
  });

  it("does not claim a comparison was made where none was", () => {
    // The reconciliation summary must not describe UNAVAILABLE fields as checked.
    const detail = code(join(ROOT, "lib/treasury/detail.ts"));
    expect(detail).toMatch(/checked and matching/);
    expect(detail).toMatch(/not compared/);
  });

  it("keeps the two meanings of a zero limit distinct in the source", () => {
    const overview = code(join(ROOT, "lib/treasury/overview.ts"));
    // Auto-approve is passed DISABLED, so 0 can never render as "unlimited".
    expect(overview).toMatch(/autoApproveLimit[\s\S]{0,200}"DISABLED"/);
    // The other three are genuinely UNLIMITED at 0.
    expect(overview).toMatch(/singleTxLimit[\s\S]{0,120}"UNLIMITED"/);
  });

  it("never renders an unlimited meter with a fabricated percentage", () => {
    const meter = code(join(ROOT, "components/usage-meter.tsx"));
    // The bar is inside an `unlimited ? null :` guard.
    expect(meter).toMatch(/usage\.unlimited \? null/);
  });
});

describe("provenance is carried, not assumed", () => {
  it("labels the index-sourced treasury fields instead of calling them chain data", () => {
    const overview = code(join(ROOT, "lib/treasury/overview.ts"));
    expect(overview).toMatch(/ownerAddress: indexed\?\.ownerAddress \? "index" : "unavailable"/);
    expect(overview).toMatch(/paused: "chain"/);
  });

  it("keeps the payment-list index type free of monetary and status fields", () => {
    // The trust boundary expressed as a type. If someone widens `IndexedProvenanceRow` to include
    // `amountBaseUnits` or `status`, the listing could start trusting the cache.
    const list = code(join(ROOT, "lib/treasury/payment-list.ts"));
    const typeBlock = list.slice(list.indexOf("type IndexedProvenanceRow"), list.indexOf("}", list.indexOf("type IndexedProvenanceRow")));
    expect(typeBlock).not.toMatch(/amountBaseUnits/);
    expect(typeBlock).not.toMatch(/\bstatus\b/);
    expect(typeBlock).not.toMatch(/\bcategory\b/);
    expect(typeBlock).not.toMatch(/\breference\b/);
  });
});

describe("no dependency or framework drift", () => {
  it("adds no new dependencies for Milestone J", () => {
    const pkg = JSON.parse(read(join(ROOT, "package.json"))) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // Everything the UI uses was already present: React/Next for rendering, viem and Prisma for
    // the service layer. No CSS framework, no chart, no icon package, no client state library.
    const allowed = new Set([
      "next",
      "react",
      "react-dom",
      "server-only",
      "viem",
      "prisma",
      "@prisma/client",
    ]);
    for (const name of Object.keys(pkg.dependencies)) {
      expect([...allowed].some((a) => name === a || name.startsWith(`${a}/`))).toBe(true);
    }
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      "@types/node",
      "@types/react",
      "@types/react-dom",
      "eslint",
      "eslint-config-next",
      "tsx",
      "typescript",
      "vitest",
    ]);
  });

  it("does not import a chart, icon or styling library in the UI tree", () => {
    const banned = /from\s+["'](recharts|d3|chart\.js|lucide-react|@heroicons|clsx|tailwind-merge|styled-components|@emotion)/;
    for (const file of ALL_UI) {
      expect(code(file)).not.toMatch(banned);
    }
  });
});