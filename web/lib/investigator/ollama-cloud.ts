import type {
  InvestigatorInput,
  InvestigatorProvider,
  InvestigatorResult,
} from "./types";
import {
  INVESTIGATOR_PROMPT_VERSION,
  INVESTIGATOR_SYSTEM_PROMPT,
  buildUserMessage,
} from "./prompt";
import { validateInvestigatorResult } from "./validate";
import { deriveEvidenceKeys } from "./evidence-keys";
import { fallbackResult, safeMessage, statusCategory } from "./logger";
import { canonicalJson } from "@/lib/evidence/canonical";

/**
 * Ollama Cloud investigator provider.
 *
 * Implements the documented Ollama Cloud HTTP contract directly:
 *   POST {base}/api/chat   with   Authorization: Bearer <OLLAMA_API_KEY>
 *   and `format: "json"` for constrained output.
 *
 * WHY JSON MODE RATHER THAN A SCHEMA IN `format`: `format` carries either a JSON Schema object
 * or the string `"json"`, never both. Sending the schema was tried first and, against the
 * pinned gpt-oss model, it was silently not honoured — the model replied in Markdown and the
 * strict parser rejected it as MALFORMED_JSON. JSON mode is the form the decoder actually
 * enforces, so syntax is guaranteed there; the required shape now travels in the system prompt
 * (`INVESTIGATOR_OUTPUT_CONTRACT`), and the result is validated and grounded afterwards in any
 * case. The parser below is unchanged and still refuses anything that is not a JSON object.
 *
 * ISOLATION: this is the ONLY module in the milestone that knows Ollama exists. It has no
 * import of the policy engine, the evidence builder, the chain adapter, or Prisma, and it
 * holds no capability to act — its entire output surface is a validated string-derived
 * object. Swapping providers means implementing `InvestigatorProvider` and changing one
 * line at the call site.
 *
 * The API key is read from the environment by `resolveOllamaCloudConfig` and is held only
 * for the lifetime of this instance, server-side. It is never returned, never logged, and
 * never placed in evidence, diagnostics, or the prompt.
 */

export const DEFAULT_OLLAMA_MODEL = "gpt-oss:20b";

export type OllamaCloudConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type OllamaCloudResolution =
  | { ok: true; config: OllamaCloudConfig }
  | { ok: false; reason: "MISSING_BASE_URL" | "MISSING_API_KEY" | "INVALID_BASE_URL" | "MISSING_MODEL" | "UNSUPPORTED_MODEL" };

/**
 * Builds the chat endpoint from a configured base URL.
 *
 * The official cloud endpoint is `https://ollama.com/api/chat`, but operators configure a
 * *base*, and both `https://ollama.com` and `https://ollama.com/api` are things a person
 * reasonably writes down. Naive concatenation of the first form yields the wrong host, and
 * of the second yields `/api/api/chat` — both fail in ways that look like an outage rather
 * than a typo. So the `/api` segment is made exactly-once, here, in one place.
 */
export function chatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/api$/i.test(trimmed) ? `${trimmed}/chat` : `${trimmed}/api/chat`;
}

/**
 * Reads provider configuration from the environment.
 *
 * Fails loudly-but-gracefully: a missing or malformed setting yields a typed failure reason
 * rather than a crash and rather than an invented default base URL. A local
 * `http://localhost:11434` is deliberately NOT substituted — this milestone targets Ollama
 * Cloud, and silently falling back to a local server would hide a misconfiguration and
 * could point production traffic at whatever happens to be listening locally.
 *
 * The model is pinned rather than configurable-in-spirit: a typo, or an attempt to quietly
 * point production at a cheaper model, must fail the request instead of silently changing
 * which model produced an explanation an operator may rely on.
 */
export type EnvLike = Record<string, string | undefined>;

export function resolveOllamaCloudConfig(env: EnvLike = process.env): OllamaCloudResolution {
  const baseUrl = env.OLLAMA_BASE_URL?.trim();
  const apiKey = env.OLLAMA_API_KEY?.trim();
  const model = env.OLLAMA_MODEL?.trim();

  if (!baseUrl) return { ok: false, reason: "MISSING_BASE_URL" };
  if (!apiKey) return { ok: false, reason: "MISSING_API_KEY" };
  if (!model) return { ok: false, reason: "MISSING_MODEL" };
  if (model !== DEFAULT_OLLAMA_MODEL) return { ok: false, reason: "UNSUPPORTED_MODEL" };

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, reason: "INVALID_BASE_URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "INVALID_BASE_URL" };
  }

  return {
    ok: true,
    config: {
      // Normalise away a trailing slash so path joining is unambiguous.
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      model,
      timeoutMs: Number(env.OLLAMA_TIMEOUT_MS ?? 60_000) || 60_000,
    },
  };
}

/** Extracts a JSON object from the model response. */
function parseModelContent(content: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false, reason: "EMPTY_RESPONSE" };

  // Structured output should already be JSON. This strips a code fence if the model wrapped
  // one despite the schema — it is NOT a general prose parser, and it deliberately refuses
  // anything that is not a JSON object rather than hunting for an embedded one.
  let candidate = trimmed;
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fence) candidate = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "MALFORMED_JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "JSON_NOT_AN_OBJECT" };
  }
  return { ok: true, value: parsed };
}

type ChatResponseBody = {
  message?: { content?: string };
  done_reason?: string;
};

export class OllamaCloudInvestigatorProvider implements InvestigatorProvider {
  readonly name = "ollama-cloud";

  constructor(private readonly config: OllamaCloudConfig) {}

  async investigate(input: InvestigatorInput): Promise<InvestigatorResult> {
    // Grounding keys come from the exact evidence we are about to send, so the model is told
    // the real key space and every citation is checked against it.
    let allowedKeys: ReturnType<typeof deriveEvidenceKeys>;
    let evidenceForKeys: unknown;
    try {
      evidenceForKeys = JSON.parse(input.evidenceJson);
      allowedKeys = deriveEvidenceKeys(evidenceForKeys);
    } catch {
      return fallbackResult("INVALID_OUTPUT", "EVIDENCE_JSON_UNPARSEABLE", "INSUFFICIENT_EVIDENCE", {
        provider: this.name,
        model: this.config.model,
      });
    }

    const started = Date.now();
    const fail = (
      status: InvestigatorResult["status"],
      reason: string,
      extra?: { ungroundedCitationCount?: number; httpStatusCategory?: string },
    ) =>
      fallbackResult(status, reason, "INSUFFICIENT_EVIDENCE", {
        provider: this.name,
        model: this.config.model,
        latencyMs: Date.now() - started,
        ...(extra ?? {}),
      });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const doFetch = this.config.fetchImpl ?? fetch;

    try {
      const response = await doFetch(chatEndpoint(this.config.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Secret travels in this header only, never in a body, log, or evidence payload.
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          // JSON mode guarantees a well-formed reply; the shape is stated in the system prompt.
          // This is not a substitute for validation — `validateInvestigatorResult` still has the
          // final word on whether the object is acceptable.
          format: "json",
          messages: [
            { role: "system", content: INVESTIGATOR_SYSTEM_PROMPT },
            {
              role: "user",
              content: buildUserMessage(
                canonicalJson(evidenceForKeys),
                input.deterministicDecision,
                allowedKeys.list,
              ),
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const category = statusCategory(response.status);
        return fail("UNAVAILABLE", `PROVIDER_HTTP_${response.status}_${category}`, { httpStatusCategory: category });
      }

      const body = (await response.json()) as ChatResponseBody;
      const content = body?.message?.content ?? "";
      const parsed = parseModelContent(content);
      if (!parsed.ok) return fail("INVALID_OUTPUT", parsed.reason);

      const validated = validateInvestigatorResult(parsed.value, allowedKeys);
      if (!validated.ok) {
        return fail("INVALID_OUTPUT", validated.reason, { ungroundedCitationCount: validated.ungroundedCitationCount });
      }
      return validated.value;
    } catch (error) {
      const message = safeMessage(error);
      if (message.includes("aborted") || message.includes("Abort")) {
        return fail("UNAVAILABLE", "PROVIDER_TIMEOUT");
      }
      return fail("UNAVAILABLE", `PROVIDER_NETWORK_ERROR`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export { INVESTIGATOR_PROMPT_VERSION };