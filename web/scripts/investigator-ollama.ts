/**
 * Milestone H — optional Ollama Cloud smoke test.
 *
 * Run with:  npm run investigator:ollama
 *
 * This is the ONLY code path that talks to Ollama Cloud. It is separate from the test suite on
 * purpose: `npm test` must stay offline, deterministic and free, so every other test mocks the
 * network. This script exists so a real end-to-end call can be made deliberately, by a human,
 * when credentials are actually available.
 *
 * It proves the contract — auth, constrained output, grounding — and nothing about policy. It
 * does not approve, execute, or alter anything: it reads one piece of Milestone G evidence and
 * prints what came back.
 */

import { resolveOllamaCloudConfig, OllamaCloudInvestigatorProvider, DEFAULT_OLLAMA_MODEL } from "../lib/investigator/ollama-cloud";
import { investigate } from "../lib/investigator/service";
import { buildCreationEvidence } from "../lib/evidence/build";
import { CHAIN_ID, MIL_E_POLICY, RECIPIENT_MILESTONE_E, TREASURY_ADDRESS } from "../lib/policy/types";
import type { PolicyDecision } from "../lib/investigator/types";

/**
 * Builds real Milestone G evidence with fixed inputs, so this run is reproducible and never
 * reads the database or the chain.
 */
function sampleEvidence() {
  return buildCreationEvidence({
    chainId: CHAIN_ID,
    treasuryAddress: TREASURY_ADDRESS,
    to: RECIPIENT_MILESTONE_E,
    amount: 10_000_000n,
    category: "MILESTONE-E",
    reference: "smoke-test",
    policy: MIL_E_POLICY,
    recipient: { approved: true, category: "MILESTONE-E" },
    counters: {
      reservedDay: {},
      reservedMonth: {},
      spentDay: {},
      spentMonth: {},
      lifetimeReserved: 0n,
      lifetimeSpent: 60_000_000n,
      balance: 140_000_000n,
      paused: false,
    },
    dayKey: 20726n,
    monthKey: 24321n,
    observedAtBlockNumber: 314303200n,
    observedAtBlockTimestamp: 1_790_774_100n,
  });
}

async function main(): Promise<void> {
  const resolved = resolveOllamaCloudConfig(process.env);

  if (!resolved.ok) {
    // Named precisely, because each of these is a configuration mistake rather than a fault
    // of the model or of the evidence. The key value itself is never printed.
    console.error(`\n  CONFIGURATION ERROR: ${resolved.reason}\n`);
    console.error("  Required, in .env (server-side only, never commit a real key):");
    console.error("    OLLAMA_BASE_URL=https://ollama.com");
    console.error("    OLLAMA_API_KEY=<your Ollama Cloud key>");
    console.error(`    OLLAMA_MODEL=${DEFAULT_OLLAMA_MODEL}\n`);
    console.error("  SKIPPED: no request was made and no credits were spent.\n");
    process.exitCode = 1;
    return;
  }

  const evidence = sampleEvidence();
  const decision = evidence.decision.offchainDecision as PolicyDecision;

  console.log("\n  Milestone H — Ollama Cloud investigator smoke test");
  console.log(`  Model      : ${resolved.config.model}`);
  console.log(`  Endpoint   : ${resolved.config.baseUrl} (never the key)`);
  console.log(`  Evidence   : ${evidence.integrityHash}`);
  console.log(`  Deterministic decision: ${decision} (reason ${evidence.decision.reason})\n`);

  const provider = new OllamaCloudInvestigatorProvider(resolved.config);
  const started = Date.now();
  const out = await investigate({
    evidence,
    policyDecision: decision,
    deterministicReason: evidence.decision.reason,
    provider,
    model: resolved.config.model,
  });

  const d = out.investigator.diagnostics;
  console.log(`  Status     : ${out.investigator.status}`);
  console.log(`  Authority  : ${out.investigator.authority}`);
  console.log(`  Recommend  : ${out.investigator.recommendation}`);
  console.log(`  Latency    : ${Date.now() - started}ms (provider reported ${d?.latencyMs ?? 0}ms)`);
  console.log(`  HTTP class : ${d?.httpStatusCategory ?? "n/a"}`);
  console.log(`  Validation : ${d?.validation ?? "n/a"}`);
  if (d?.failureReason) console.log(`  Failure    : ${d.failureReason}`);

  console.log("\n  Summary    :");
  console.log(`    ${out.investigator.summary}`);

  for (const finding of out.investigator.findings) {
    console.log(`\n  [${finding.type}] ${finding.statement}`);
    for (const key of finding.evidenceKeys) console.log(`      grounded: ${key}`);
  }

  for (const uncertainty of out.investigator.uncertainties) {
    console.log(`\n  Uncertainty: ${uncertainty}`);
  }

  // The invariant this milestone exists to guarantee, printed last so it cannot be missed.
  const unchanged = out.policyDecision === decision;
  console.log(`\n  Deterministic decision preserved: ${unchanged ? "YES" : "NO — INVESTIGATE IMMEDIATELY"}`);
  if (!unchanged) process.exitCode = 1;

  if (out.investigator.status !== "OK") {
    console.log("\n  Result was advisory-only: no explanation was produced. Nothing was approved or executed.\n");
    process.exitCode = 1;
    return;
  }
  console.log("\n  Advisory only. Nothing was approved, signed, or executed.\n");
}

main().catch((error: unknown) => {
  console.error(`\n  SMOKE TEST FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});