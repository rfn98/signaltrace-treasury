/**
 * Milestone I live smoke test: one real investigation, end to end.
 *
 * READ-ONLY. Runs the production `investigatePayment` against the real database and the real
 * Arbitrum Sepolia deployment, prints the composed result, and exits. It cannot move funds: the
 * only operations behind it are `findFirst`/`findMany` and `view`/`pure` calls.
 *
 * The AI layer is optional by design. With Ollama Cloud configured the explanation is produced;
 * without it `investigator.status` is UNAVAILABLE and the deterministic verdict is still real
 * and still returned — which is exactly the degradation the milestone specifies. The script
 * reports which of the two happened rather than failing, so an absent key is never mistaken for
 * a broken investigation.
 *
 * Usage:  npm run investigate:payment -- [paymentId]
 *
 * Run it through the npm script rather than calling tsx directly. `lib/investigation/repository.ts`
 * is marked `server-only`, and that package throws on import unless Node resolves it under the
 * `react-server` export condition — which is what the Next.js bundler does, and what plain `tsx`
 * does not. The npm script therefore passes `--conditions=react-server`. Invoking
 * `npx tsx scripts/investigate-payment.ts` by hand throws "This module cannot be imported from a
 * Client Component module", which reads like a bundling bug rather than a missing flag.
 *
 * Env:    ARBITRUM_SEPOLIA_RPC_URL (falls back to RPC_URL in contracts/.env)
 *         DATABASE_URL
 *         OLLAMA_BASE_URL / OLLAMA_API_KEY (optional; AI explanation only)
 */
import { investigatePayment } from "@/lib/investigation/service";
import { investigationDeps } from "@/lib/investigation/deps";
import { envValue } from "@/lib/env";
import { resolveOllamaCloudConfig } from "@/lib/investigator/ollama-cloud";

function required(key: string): string {
  const value = envValue(key);
  if (!value) {
    console.error(`UNAVAILABLE: ${key} is not set. Cannot run the live investigation.`);
    process.exit(2);
  }
  return value as string;
}

async function main(): Promise<void> {
  const paymentId = process.argv[2] ?? "1";

  // Loaded here rather than in the app because Next.js populates process.env itself at boot;
  // a bare `tsx` script has to do it explicitly, exactly as `reconcile-chain.ts` does.
  process.env.DATABASE_URL = required("DATABASE_URL");
  const rpc = envValue("ARBITRUM_SEPOLIA_RPC_URL") ?? envValue("RPC_URL");
  if (!rpc) {
    console.error("UNAVAILABLE: no RPC URL (set ARBITRUM_SEPOLIA_RPC_URL or RPC_URL)");
    process.exit(2);
  }
  process.env.ARBITRUM_SEPOLIA_RPC_URL = rpc;

  const ai = resolveOllamaCloudConfig(process.env);
  console.log(`Investigating payment ${paymentId} on Arbitrum Sepolia...`);
  console.log(
    ai.ok
      ? `AI layer: CONFIGURED (model ${ai.config.model})`
      : `AI layer: NOT CONFIGURED (${ai.reason}) — advisory result will be UNAVAILABLE`,
  );
  console.log("");

  const outcome = await investigatePayment(paymentId, investigationDeps());

  if (!outcome.ok) {
    console.error(`RESULT: ${outcome.error.code} — ${outcome.error.message}`);
    if (outcome.result?.gating.length) {
      console.error("");
      for (const gate of outcome.result.gating) {
        console.error(`  gate ${gate.code}: ${gate.detail}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  const r = outcome.result;
  console.log("RESULT: 200");
  console.log(`  investigation      ${r.investigationVersion}`);
  console.log(`  payment            ${r.request.paymentId}`);
  console.log(`  reference          ${r.request.reference}`);
  console.log(`  policy.decision    ${r.policy.decision}`);
  console.log(`  policy.allowed     ${r.policy.allowed}`);
  console.log(`  policy.reason      ${r.policy.reasonName}`);
  console.log(`  evidence.hash      ${r.evidence.hash}`);
  console.log(`  observed at block  ${r.evidence.observedAtBlockNumber}`);
  console.log(`  on-chain status    ${r.context.onChainStatus}`);
  console.log(`  mirror agrees      ${r.context.mirrorAgreesWithContract}`);
  console.log(
    `  reconciliation     ${r.reconciliation.overall} ` +
      `(${r.reconciliation.summary.match} match, ${r.reconciliation.summary.mismatch} mismatch, ` +
      `${r.reconciliation.summary.unavailable} unavailable)`,
  );
  console.log(`  investigator       ${r.investigator.status}`);
  console.log(`  recommendation     ${r.investigator.recommendation}`);
  console.log(`  authority          ${r.investigator.authority}`);
  console.log(`  findings           ${r.investigator.findings.length}`);
  console.log(`  gating             ${r.gating.length}`);
  console.log("");

  if (!ai.ok) {
    console.log("AI SMOKE TEST SKIPPED — no Ollama Cloud credentials configured.");
  } else if (r.investigator.status !== "OK") {
    console.error(`AI SMOKE TEST FAILED — provider returned ${r.investigator.status}`);
    process.exitCode = 1;
  } else {
    console.log("AI SMOKE TEST PASSED — a live explanation was produced and re-validated.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});