import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { investigate } from "@/lib/investigator/service";
import { makeEvidence } from "./fixtures";

/**
 * Architecture and security guards.
 *
 * These do not test behaviour a case can already observe — they test properties that would
 * otherwise only be checked by reading every file, and that a future refactor could break
 * silently. The investigator's safety does not come from one careful function; it comes from
 * the absence of capability everywhere else. If a future change gives this module a database
 * handle, an RPC client, or a signer, the guarantee is gone and nothing at runtime would say so.
 */

const MODULE_DIR = join(process.cwd(), "lib", "investigator");

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(MODULE_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    // Tests are excluded: they name these forbidden things precisely in order to assert their
    // absence, so scanning them would make the guard fail on its own test suite.
    .filter((f) => !f.replace(/\\/g, "/").startsWith("__tests__/"))
    .map((f) => ({ name: f, text: readFileSync(join(MODULE_DIR, f), "utf8") }));
}

describe("investigator module isolation", () => {
  it("imports nothing that can act, persist, or reach the chain", () => {
    const forbidden = [
      /from\s+["'][^"']*prisma[^"']*["']/i,
      /from\s+["'][^"']*\/chain\//i,
      /from\s+["'][^"']*viem/i,
      /from\s+["'][^"']*wagmi/i,
      /from\s+["'][^"']*ethers/i,
      /from\s+["'][^"']*wallet/i,
      /\bprivateKey\b/,
      /\bmnemonic\b/,
      /\bwriteContract\b/,
      /\bsendTransaction\b/,
      /\bexecutePayment\b/,
      /process\.env\s*\.\s*DATABASE_URL/,
    ];

    for (const file of sourceFiles()) {
      for (const pattern of forbidden) {
        expect(pattern.test(file.text), `${file.name} matched ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps every source file free of embedded credentials", () => {
    // A literal that looks like a real key is how a secret gets committed by accident.
    const suspicious = /(sk-[A-Za-z0-9]{16,}|oll_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9]{16,})/;
    for (const file of sourceFiles()) {
      expect(suspicious.test(file.text), `${file.name} appears to contain a credential`).toBe(false);
    }
  });

  it("exposes no route handler, server action, or client component from the module", () => {
    const expectations: [RegExp, string][] = [
      [/["']use server["']/, "server action directive"],
      [/\bNextResponse\b/, "Next.js response helper"],
      [/\bexport\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/, "HTTP route handler"],
      [/["']use client["']/, "client component directive"],
    ];
    for (const file of sourceFiles()) {
      for (const [pattern, label] of expectations) {
        expect(pattern.test(file.text), `${file.name} contains a ${label}`).toBe(false);
      }
    }
  });
});

describe("investigator output surface", () => {
  it("carries no field that a caller could mistake for an instruction to act", async () => {
    const out = await investigate({
      evidence: makeEvidence(),
      policyDecision: makeEvidence().decision.offchainDecision,
      deterministicReason: makeEvidence().decision.reason,
      provider: {
        name: "mock",
        investigate: async () => ({
          status: "OK" as const,
          summary: "Fine.",
          recommendation: "PROCEED_TO_HUMAN_REVIEW" as const,
          findings: [],
          uncertainties: [],
          authority: "ADVISORY_ONLY" as const,
        }),
      },
      model: "gpt-oss:20b",
    });

    // Exactly these keys, and no more. A new key is a new capability, so the shape is pinned.
    expect(Object.keys(out).sort()).toEqual([
      "deterministicReason",
      "evidenceIntegrityHash",
      "investigator",
      "policyDecision",
    ]);
    expect(Object.keys(out.investigator).sort()).toEqual([
      "authority",
      "diagnostics",
      "findings",
      "recommendation",
      "status",
      "summary",
      "uncertainties",
    ]);
  });

  it("never resolves to a decision-bearing envelope without the deterministic result present", async () => {
    const evidence = makeEvidence();
    const out = await investigate({
      evidence,
      policyDecision: evidence.decision.offchainDecision,
      deterministicReason: evidence.decision.reason,
      provider: {
        name: "mock",
        investigate: async () => {
          throw new Error("down");
        },
      },
      model: "gpt-oss:20b",
    });

    // The deterministic fields are populated even on total provider failure — the AI is
    // additive, so its absence can never leave the caller without a verdict.
    expect(out.policyDecision).toBe(evidence.decision.offchainDecision);
    expect(out.deterministicReason).toBe(evidence.decision.reason);
    expect(out.evidenceIntegrityHash).toBe(evidence.integrityHash);
  });
});