/**
 * Milestone I architecture tests.
 *
 * These assert properties of the PRODUCTION source that no amount of functional testing can
 * establish, because their failure mode is code that does not exist yet. The question they answer
 * is not "does the investigation work" but "what is this module even capable of".
 *
 * Read this as a standing answer to the obvious objection: an investigation endpoint that could
 * move money, or that handed the model a database handle, would still pass every behavioural
 * test in the suite. So the capability is checked directly, in the source.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { toResponse } from "@/app/api/investigations/[paymentId]/route";
import { HTTP_STATUS_BY_CODE, INVESTIGATION_VERSION } from "../types";

const ROOT = process.cwd();

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...filesIn(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Production Milestone I sources: the module and the route, excluding tests. */
const I_SOURCES = [
  ...filesIn(join(ROOT, "lib", "investigation")),
  join(ROOT, "app", "api", "investigations", "[paymentId]", "route.ts"),
];

const readAll = () => I_SOURCES.map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8") }));

describe("Milestone I has no execution capability", () => {
  it.each([
    ["a private key or mnemonic", /privateKey|private_key|mnemonic|seed phrase|PRIVATE_KEY/i],
    ["a wallet client", /createWalletClient|WalletClient|walletClient|privateKeyToAccount/i],
    ["a contract write", /writeContract|sendTransaction|prepareTransactionRequest|writeContractSync/i],
    ["an ethers signer", /new ethers\.Contract|JsonRpcSigner|ethers\.Wallet|getSigners/i],
    ["a Solidity transaction intent", /executePayment\(|submitPayment\(|approvePayment\(/i],
    ["a wagmi/viem write hook", /useWriteContract|useSendTransaction|useWalletClient/i],
  ])("Milestone I sources contain no %s", (_label, pattern) => {
    for (const { path, text } of readAll()) {
      expect(text, `${path} must not reference ${String(pattern)}`).not.toMatch(pattern);
    }
  });

  it("reads the chain only through Milestone G's read-only adapter", () => {
    const offenders = readAll().filter(
      ({ text }) => !text.includes("@/lib/chain/adapter") && /\breadContract\b|\bgetBlock\b|\bcreatePublicClient\b/.test(text),
    );
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it("writes nothing to the database", () => {
    // The repository is the only Prisma surface and must stay read-only. A future
    // "let me just cache the investigation" change would show up here.
    const repo = readFileSync(join(ROOT, "lib", "investigation", "repository.ts"), "utf8");
    for (const write of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "$executeRaw", "$queryRaw"]) {
      expect(repo, `repository.ts must not call ${write}`).not.toMatch(new RegExp(`\\.${write}\\s*\\(`));
    }
  });
});

describe("the AI cannot reach the database or the chain", () => {
  it("hands the model serialized evidence and nothing else", () => {
    const service = readFileSync(join(ROOT, "lib", "investigation", "service.ts"), "utf8");
    // The provider is called with the input Milestone H builds from the evidence alone. If this
    // ever grew a repository or a client reference, the model would be one query away from the
    // whole database.
    expect(service).not.toMatch(/provider\.investigate\(\s*\{[^}]*repository/);
    expect(service).not.toMatch(/provider\.investigate\(\s*\{[^}]*chain/);
    expect(service).toMatch(/investigate\(\{/);
  });

  it("never derives the policy decision from investigator output", () => {
    const service = readFileSync(join(ROOT, "lib", "investigation", "service.ts"), "utf8");
    const verdict = /const policyDecision[^=]*=\s*([^;]+);/.exec(service)?.[1] ?? "";
    // The verdict comes from the G evidence record. If it were ever read off the advisory
    // result, the boundary this milestone exists to enforce would be gone.
    expect(verdict).toContain("evidence.decision.offchainDecision");
    expect(verdict).not.toContain("advisory");
    expect(verdict).not.toContain("investigator");
  });

  it("keeps recommendation and decision in separate fields", () => {
    const service = readFileSync(join(ROOT, "lib", "investigation", "service.ts"), "utf8");
    // No assignment from one to the other anywhere in the module.
    expect(service).not.toMatch(/policy\.decision\s*=\s*[^=]*recommendation/);
    expect(service).not.toMatch(/recommendation\s*=\s*[^=]*policy\.decision/);
  });
});

describe("result shape is pinned", () => {
  it("carries every documented section", () => {
    const keys = [
      "investigationVersion",
      "request",
      "policy",
      "evidence",
      "investigator",
      "reconciliation",
      "context",
      "gating",
    ];
    const types = readFileSync(join(ROOT, "lib", "investigation", "types.ts"), "utf8");
    for (const key of keys) expect(types).toContain(`${key}:`);
    expect(INVESTIGATION_VERSION).toBe("signaltrace.investigation/v1");
  });

  it("keeps the investigator advisory only, and does not widen it", () => {
    // Milestone H owns the literal. The assertion that matters here is negative: Milestone I
    // narrows nothing and introduces no second, looser authority type.
    const iTypes = readFileSync(join(ROOT, "lib", "investigation", "types.ts"), "utf8");
    expect(iTypes).toContain("Omit<InvestigatorResult, \"status\">");
    expect(iTypes).not.toMatch(/authority:\s*(?!")/);

    const hTypes = readFileSync(join(ROOT, "lib", "investigator", "types.ts"), "utf8");
    expect(hTypes).toContain('authority: "ADVISORY_ONLY"');

    // And the service can only ever write that one value.
    const service = readFileSync(join(ROOT, "lib", "investigation", "service.ts"), "utf8");
    for (const authority of service.match(/authority:\s*"([^"]+)"/g) ?? []) {
      expect(authority).toBe('authority: "ADVISORY_ONLY"');
    }
  });
});

describe("HTTP contract", () => {
  it.each([
    ["INVALID_PAYMENT_ID", 400],
    ["PAYMENT_NOT_FOUND", 404],
    ["DEPENDENCY_UNAVAILABLE", 503],
    ["EVIDENCE_INCONSISTENT", 422],
    ["EVIDENCE_INSUFFICIENT", 422],
  ] as const)("maps %s to HTTP %i", (code, status) => {
    expect(HTTP_STATUS_BY_CODE[code]).toBe(status);
  });

  it("returns 200 with the investigation on success", async () => {
    const response = toResponse({
      ok: true,
      result: { investigationVersion: INVESTIGATION_VERSION } as never,
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ["PAYMENT_NOT_FOUND", 404, false],
    ["DEPENDENCY_UNAVAILABLE", 503, false],
    ["EVIDENCE_INCONSISTENT", 422, true],
  ] as const)("returns %i for %s", async (code, status, carriesResult) => {
    const response = toResponse({
      ok: false,
      error: { code, message: "safe message" },
      result: carriesResult ? ({ investigationVersion: INVESTIGATION_VERSION } as never) : null,
    });
    expect(response.status).toBe(status);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toMatchObject({ code });
    if (carriesResult) expect(body.investigation).toBeDefined();
  });

  it("never caches an investigation response", async () => {
    const response = toResponse({ ok: true, result: { investigationVersion: INVESTIGATION_VERSION } as never });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never leaks internals through an error body", async () => {
    const response = toResponse({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "the payment index could not be read" },
      result: null,
    });
    const text = await response.text();
    for (const leak of ["DATABASE_URL", "prisma", "postgres", "Error:", "at Object", "0x", "stack"]) {
      expect(text).not.toContain(leak);
    }
  });
});

describe("no aggressive retries", () => {
  it("calls each dependency at most once per investigation", () => {
    const service = readFileSync(join(ROOT, "lib", "investigation", "service.ts"), "utf8");
    // No retry loops, no backoff, no attempt counters anywhere in the orchestration.
    expect(service).not.toMatch(/\bretry\b|\bbackoff\b|attempt\s*[<>=]|maxRetries/i);
  });
});

describe("Milestone I composes the earlier milestones instead of duplicating them", () => {
  it("reuses the Milestone G evidence builder, evaluator and reconciliation", () => {
    const service = readFileSync(join(ROOT, "lib", "investigation", "service.ts"), "utf8");
    expect(service).toContain("@/lib/evidence/build");
    expect(service).toContain("@/lib/policy/evaluate");
    expect(service).toContain("@/lib/reconcile/compare");
    expect(service).toContain("@/lib/investigator/service");
  });

  it("does not re-derive policy limits or verdict rules locally", () => {
    const service = readFileSync(join(ROOT, "lib", "investigation", "service.ts"), "utf8");
    // A local copy of a limit or a reason ordering would be the first step towards drifting from
    // Treasury.sol, so none may appear here.
    for (const token of ["autoApproveLimit", "singleTxLimit", "dailyLimit", "monthlyLimit"]) {
      const uses = new RegExp(`\\b${token}\\b`, "g");
      const hits = service.match(uses) ?? [];
      expect(hits.length, `${token} must not be interpreted in Milestone I`).toBe(0);
    }
  });
});