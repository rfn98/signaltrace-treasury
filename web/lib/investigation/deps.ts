/**
 * Milestone I — production dependency wiring.
 *
 * Kept in its own module so `service.ts` stays free of Prisma, viem and environment access:
 * the orchestration is testable with observed state injected, and the only place that knows
 * about real credentials is here.
 *
 * TWO DEGRADATIONS ARE DELIBERATE, and they are not the same:
 *
 *   - No AI credentials is NOT a failure. The deterministic policy verdict is still correct and
 *     still returned; only the explanation is missing, and `investigator.status` says
 *     UNAVAILABLE. An investigation endpoint that hard-fails without an LLM key would make the
 *     most important part of the answer depend on the least important part of the stack.
 *   - No RPC URL IS a failure, because without observed chain state there is no verdict to
 *     report at all. That surfaces as DEPENDENCY_UNAVAILABLE (503) rather than as a guess.
 */
import { PrismaPaymentRepository } from "./repository";
import { ViemChainStateReader } from "./chain-state";
import {
  DEFAULT_OLLAMA_MODEL,
  OllamaCloudInvestigatorProvider,
  resolveOllamaCloudConfig,
} from "@/lib/investigator/ollama-cloud";
import { fallbackResult } from "@/lib/investigator/logger";
import type { InvestigatorProvider, InvestigatorResult } from "@/lib/investigator/types";
import type { ChainStateReader, PaymentRepository } from "./types";
import type { InvestigationDeps } from "./service";

/**
 * A provider that makes no network call and reports itself unavailable.
 *
 * Used when the AI is not configured, so the advisory layer degrades to "no explanation"
 * instead of to an error that would mask a perfectly good deterministic verdict. It returns
 * Milestone H's own `fallbackResult`, so its output is indistinguishable in shape from a real
 * provider outage and passes the same re-validation.
 */
export function unavailableProvider(reason: string, model = DEFAULT_OLLAMA_MODEL): InvestigatorProvider {
  return {
    name: "unconfigured",
    // Declared without parameters: this provider is not given the evidence, so there is nothing
    // to read. The interface is satisfied structurally and the unused argument disappears with it.
    async investigate(): Promise<InvestigatorResult> {
      return fallbackResult("UNAVAILABLE", reason, "INSUFFICIENT_EVIDENCE", {
        provider: "unconfigured",
        model,
      });
    },
  };
}

/** Reads the RPC URL without throwing when it is absent; the caller decides what to do. */
function rpcUrlFromEnv(): string | undefined {
  return process.env.ARBITRUM_SEPOLIA_RPC_URL ?? process.env.RPC_URL;
}

/**
 * Builds the real dependency set.
 *
 * The RPC URL is read per request rather than captured at module load, so a test or a script can
 * point this at a different endpoint without the module graph having been initialised first.
 */
export function investigationDeps(): InvestigationDeps {
  const config = resolveOllamaCloudConfig(process.env);

  const provider: InvestigatorProvider = config.ok
    ? new OllamaCloudInvestigatorProvider(config.config)
    : unavailableProvider(config.reason);

  const rpcUrl = rpcUrlFromEnv();
  const repository: PaymentRepository = new PrismaPaymentRepository();
  // A missing RPC URL surfaces as a read failure inside the service, which is the same path a
  // genuinely unreachable endpoint takes. One error shape, not two.
  const chain: ChainStateReader = new ViemChainStateReader(rpcUrl ?? "");

  return { repository, chain, provider, model: config.ok ? config.config.model : DEFAULT_OLLAMA_MODEL };
}