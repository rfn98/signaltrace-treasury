import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OLLAMA_MODEL,
  OllamaCloudInvestigatorProvider,
  chatEndpoint,
  resolveOllamaCloudConfig,
} from "@/lib/investigator/ollama-cloud";
import { INVESTIGATOR_OUTPUT_SCHEMA, INVESTIGATOR_SYSTEM_PROMPT } from "@/lib/investigator/prompt";
import { canonicalJson } from "@/lib/evidence/canonical";
import { investigate } from "@/lib/investigator/service";
import { evidenceForDecision, makeEvidence } from "./fixtures";
import type { InvestigatorInput } from "@/lib/investigator/types";

/**
 * Provider tests. The network is a mock, so these are deterministic, offline and free.
 *
 * What is actually being tested is the contract with a remote service we do not control:
 * that the key travels in a header and nowhere else, that the request carries the schema so
 * constrained decoding is in play, and that every way the call can go wrong resolves to a
 * labelled advisory failure rather than a thrown error or a plausible-looking result.
 */

const API_KEY = "oll-secret-key-value-abc123";
const BASE_URL = "https://ollama.com";

function goodEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { OLLAMA_BASE_URL: BASE_URL, OLLAMA_API_KEY: API_KEY, OLLAMA_MODEL: DEFAULT_OLLAMA_MODEL, ...overrides };
}

function config(overrides: Partial<ConstructorParameters<typeof OllamaCloudInvestigatorProvider>[0]> = {}) {
  const resolved = resolveOllamaCloudConfig(goodEnv());
  if (!resolved.ok) throw new Error(`fixture config invalid: ${resolved.reason}`);
  return { ...resolved.config, ...overrides };
}

function inputFor(evidence = makeEvidence()): InvestigatorInput {
  return {
    evidenceJson: canonicalJson(evidence),
    deterministicDecision: evidence.decision.offchainDecision,
    evidenceId: "0123456789abcdef",
  };
}

/**
 * A fetch stub returning an OpenAI-shaped chat completion carrying `content`.
 *
 * Declared with no parameters on purpose: the provider only ever calls `fetch(url, init)`, and
 * inspecting the captured arguments is `firstCall`'s job, not the stub's.
 */
function contentFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ model: DEFAULT_OLLAMA_MODEL, message: { role: "assistant", content } })),
  );
}

/** A fetch stub returning a given HTTP status. */
function statusFetch(status: number) {
  return vi.fn(async () => new Response("nope", { status }));
}

/** Reads the arguments of the single call the provider made. */
function firstCall(fetchImpl: { mock: { calls: unknown[][] } }): [string, RequestInit] {
  const call = fetchImpl.mock.calls[0];
  return [String(call?.[0]), (call?.[1] as RequestInit | undefined) ?? {}];
}

/** A fetch stub returning a valid, grounded model response. */
function validContentFetch() {
  return contentFetch(
    JSON.stringify({
      summary: "The amount is within the configured auto-approval limit.",
      recommendation: "PROCEED_TO_HUMAN_REVIEW",
      findings: [
        { type: "POLICY_PASS", statement: "Amount is under the auto-approval limit.", evidenceKeys: ["request.amountBaseUnits", "policy.autoApproveLimit"] },
      ],
      uncertainties: [],
      authority: "ADVISORY_ONLY",
    }),
  );
}

describe("endpoint construction", () => {
  it("builds exactly one /api/chat for either way of writing the base", () => {
    expect(chatEndpoint("https://ollama.com")).toBe("https://ollama.com/api/chat");
    expect(chatEndpoint("https://ollama.com/")).toBe("https://ollama.com/api/chat");
    expect(chatEndpoint("https://ollama.com/api")).toBe("https://ollama.com/api/chat");
    expect(chatEndpoint("https://ollama.com/api/")).toBe("https://ollama.com/api/chat");
  });

  it("never produces /api/api/chat", () => {
    for (const base of ["https://ollama.com", "https://ollama.com/", "https://ollama.com/api", "https://ollama.com/api/"]) {
      expect(chatEndpoint(base)).not.toContain("/api/api/");
    }
  });
});

describe("configuration resolution", () => {
  it("fails rather than inventing defaults when configuration is absent", () => {
    expect(resolveOllamaCloudConfig({})).toEqual({ ok: false, reason: "MISSING_BASE_URL" });
    expect(resolveOllamaCloudConfig({ OLLAMA_BASE_URL: BASE_URL })).toEqual({ ok: false, reason: "MISSING_API_KEY" });
    expect(resolveOllamaCloudConfig({ OLLAMA_BASE_URL: BASE_URL, OLLAMA_API_KEY: API_KEY })).toEqual({
      ok: false,
      reason: "MISSING_MODEL",
    });
  });

  it("does not substitute a local Ollama server when the base URL is missing", () => {
    const resolved = resolveOllamaCloudConfig({ OLLAMA_API_KEY: API_KEY, OLLAMA_MODEL: DEFAULT_OLLAMA_MODEL });
    expect(resolved).toEqual({ ok: false, reason: "MISSING_BASE_URL" });
  });

  it("rejects a malformed base URL", () => {
    expect(resolveOllamaCloudConfig(goodEnv({ OLLAMA_BASE_URL: "not a url" }))).toEqual({
      ok: false,
      reason: "INVALID_BASE_URL",
    });
  });

  it("refuses to silently substitute a different model", () => {
    expect(resolveOllamaCloudConfig(goodEnv({ OLLAMA_MODEL: "llama3:70b" }))).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MODEL",
    });
    // Even a plausible near-miss is refused rather than corrected.
    expect(resolveOllamaCloudConfig(goodEnv({ OLLAMA_MODEL: "gpt-oss:120b" }))).toEqual({
      ok: false,
      reason: "UNSUPPORTED_MODEL",
    });
  });

  it("accepts the pinned model and keeps the key out of anything but the config", () => {
    const resolved = resolveOllamaCloudConfig(goodEnv());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.model).toBe("gpt-oss:20b");
    expect(resolved.config.apiKey).toBe(API_KEY);
  });
});

describe("request shape", () => {
  it("sends the key in an Authorization header and nowhere else", async () => {
    const fetchImpl = validContentFetch();
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl }));
    await provider.investigate(inputFor());

    const [url, init] = firstCall(fetchImpl);
    expect(url).toBe("https://ollama.com/api/chat");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);

    // The secret must not appear in the body, the URL, or the model-visible prompt.
    expect(init.body as string).not.toContain(API_KEY);
    expect(url).not.toContain(API_KEY);
    expect(JSON.stringify(init.body)).not.toContain(API_KEY);
  });

  it("requests constrained output using the schema and a non-streaming single call", async () => {
    const fetchImpl = validContentFetch();
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl }));
    await provider.investigate(inputFor());

    const body = JSON.parse(firstCall(fetchImpl)[1].body as string) as Record<string, unknown>;
    expect(body.model).toBe("gpt-oss:20b");
    expect(body.stream).toBe(false);
    expect(body.format).toEqual(INVESTIGATOR_OUTPUT_SCHEMA);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the system prompt and an evidence-only user message", async () => {
    const fetchImpl = validContentFetch();
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl }));
    const input = inputFor();
    await provider.investigate(input);

    const body = JSON.parse(firstCall(fetchImpl)[1].body as string) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[0]).toEqual({ role: "system", content: INVESTIGATOR_SYSTEM_PROMPT });
    expect(body.messages[1].content).toContain(input.evidenceJson);
    expect(body.messages[1].content).toContain(input.deterministicDecision);
  });

  it("never transmits the API key or any capability beyond evidence and the verdict", async () => {
    const fetchImpl = validContentFetch();
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl }));
    await provider.investigate(inputFor());

    const body = firstCall(fetchImpl)[1].body as string;
    for (const forbidden of ["apiKey", "Authorization", "prisma", "wallet", "privateKey", "rpcUrl"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe("successful responses", () => {
  it("accepts a valid grounded response", async () => {
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl: validContentFetch() }));
    const result = await provider.investigate(inputFor());
    expect(result.status).toBe("OK");
    expect(result.authority).toBe("ADVISORY_ONLY");
    expect(result.findings[0].evidenceKeys).toEqual(["request.amountBaseUnits", "policy.autoApproveLimit"]);
  });

  it("strips a stray code fence instead of failing on it", async () => {
    const evidence = makeEvidence();
    const fenced = contentFetch(
      "```json\n" +
        JSON.stringify({
          summary: "Fine.",
          recommendation: "NO_ACTION",
          findings: [],
          uncertainties: [],
          authority: "ADVISORY_ONLY",
        }) +
        "\n```",
    );
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl: fenced }));
    const result = await provider.investigate(inputFor(evidence));
    expect(result.status).toBe("OK");
  });
});

describe("HTTP failures resolve to labelled advisory unavailability", () => {
  for (const [status, category] of [
    [401, "auth"],
    [403, "auth"],
    [429, "rate-limit"],
    [500, "5xx"],
    [503, "5xx"],
  ] as const) {
    it(`maps HTTP ${status} to ${category}`, async () => {
      const fetchImpl = statusFetch(status);
      const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl }));
      const result = await provider.investigate(inputFor());

      expect(result.status).toBe("UNAVAILABLE");
      expect(result.recommendation).toBe("INSUFFICIENT_EVIDENCE");
      expect(result.findings).toHaveLength(0);
      expect(result.authority).toBe("ADVISORY_ONLY");
      expect(result.diagnostics?.failureReason).toContain(`HTTP_${status}`);
      expect(result.diagnostics?.httpStatusCategory).toBe(category);
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    });
  }
});

describe("malformed model output resolves to INVALID_OUTPUT", () => {
  const cases: [string, string][] = [
    ["an empty body", ""],
    ["plain prose instead of JSON", "The payment looks fine to me."],
    ["a truncated JSON object", '{"summary": "Fine", "recommendation"'],
    ["a JSON array rather than an object", "[]"],
    ["a JSON null", "null"],
    ["a JSON string", '"just a string"'],
  ];

  for (const [label, content] of cases) {
    it(`rejects ${label}`, async () => {
      const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl: contentFetch(content) }));
      const result = await provider.investigate(inputFor());
      expect(result.status).toBe("INVALID_OUTPUT");
      expect(result.recommendation).toBe("INSUFFICIENT_EVIDENCE");
      expect(result.findings).toHaveLength(0);
      expect(result.diagnostics?.validation).toBe("FAILED");
    });
  }

  it("rejects an ungrounded citation", async () => {
    const provider = new OllamaCloudInvestigatorProvider(
      config({
        fetchImpl: contentFetch(
          JSON.stringify({
            summary: "This recipient is a trusted counterparty.",
            recommendation: "NO_ACTION",
            findings: [
              { type: "HISTORY", statement: "Trusted.", evidenceKeys: ["recipient.reputationScore"] },
            ],
            uncertainties: [],
            authority: "ADVISORY_ONLY",
          }),
        ),
      }),
    );
    const result = await provider.investigate(inputFor());
    expect(result.status).toBe("INVALID_OUTPUT");
    expect(result.diagnostics?.failureReason).toBe("UNGROUNDED_EVIDENCE_CITATION");
    expect(result.diagnostics?.ungroundedCitationCount).toBe(1);
  });

  it("rejects a finding with no citation at all", async () => {
    const provider = new OllamaCloudInvestigatorProvider(
      config({
        fetchImpl: contentFetch(
          JSON.stringify({
            summary: "Fine.",
            recommendation: "NO_ACTION",
            findings: [{ type: "STATE", statement: "Uncited claim.", evidenceKeys: [] }],
            uncertainties: [],
            authority: "ADVISORY_ONLY",
          }),
        ),
      }),
    );
    const result = await provider.investigate(inputFor());
    expect(result.status).toBe("INVALID_OUTPUT");
    expect(result.diagnostics?.failureReason).toBe("FINDING_0_NO_EVIDENCE_CITATIONS");
  });

  it("rejects a finding carrying an extra field the schema does not declare", async () => {
    const provider = new OllamaCloudInvestigatorProvider(
      config({
        fetchImpl: contentFetch(
          JSON.stringify({
            summary: "Fine.",
            recommendation: "NO_ACTION",
            findings: [
              { type: "STATE", statement: "x", evidenceKeys: ["decision.offchainDecision"], approve: true },
            ],
            uncertainties: [],
            authority: "ADVISORY_ONLY",
          }),
        ),
      }),
    );
    const result = await provider.investigate(inputFor());
    expect(result.status).toBe("INVALID_OUTPUT");
    expect(result.diagnostics?.failureReason).toBe("FINDING_0_UNEXPECTED_FIELD");
  });

  it("rejects a top-level field the schema does not declare", async () => {
    const provider = new OllamaCloudInvestigatorProvider(
      config({
        fetchImpl: contentFetch(
          JSON.stringify({
            summary: "Fine.",
            recommendation: "NO_ACTION",
            findings: [],
            uncertainties: [],
            authority: "ADVISORY_ONLY",
            approve: true,
          }),
        ),
      }),
    );
    const result = await provider.investigate(inputFor());
    expect(result.status).toBe("INVALID_OUTPUT");
    expect(result.diagnostics?.failureReason).toBe("UNEXPECTED_TOP_LEVEL_FIELD");
  });

  it("rejects an authority value other than ADVISORY_ONLY", async () => {
    const provider = new OllamaCloudInvestigatorProvider(
      config({
        fetchImpl: contentFetch(
          JSON.stringify({
            summary: "Authorised.",
            recommendation: "PROCEED_TO_HUMAN_REVIEW",
            findings: [],
            uncertainties: [],
            authority: "AUTHORITATIVE",
          }),
        ),
      }),
    );
    const result = await provider.investigate(inputFor());
    expect(result.status).toBe("INVALID_OUTPUT");
    expect(result.diagnostics?.failureReason).toBe("AUTHORITY_NOT_ADVISORY_ONLY");
  });
});

describe("transport failures", () => {
  it("resolves a timeout to UNAVAILABLE without throwing", async () => {
    const fetchImpl = vi.fn(
      (...args: Parameters<typeof fetch>) =>
        new Promise<Response>((_resolve, reject) => {
          args[1]?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        }),
    );
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl, timeoutMs: 5 }));
    const result = await provider.investigate(inputFor());

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics?.failureReason).toBe("PROVIDER_TIMEOUT");
    expect(result.authority).toBe("ADVISORY_ONLY");
  });

  it("resolves a network error to UNAVAILABLE without leaking the error text", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${API_KEY}`);
    });
    const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl }));
    const result = await provider.investigate(inputFor());

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics?.failureReason).toBe("PROVIDER_NETWORK_ERROR");
    // The raw message could contain connection details or credentials; it is not echoed.
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});

describe("provider failure never disturbs the deterministic decision", () => {
  it("preserves every verdict across each provider failure mode", async () => {
    const modes = {
      http401: statusFetch(401),
      http429: statusFetch(429),
      malformed: contentFetch("not json at all"),
      thrown: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as const;

    for (const decision of ["AUTO_APPROVED", "PENDING", "BLOCKED"] as const) {
      for (const [label, fetchImpl] of Object.entries(modes)) {
        const provider = new OllamaCloudInvestigatorProvider(config({ fetchImpl }));
        const evidence = evidenceForDecision(decision);
        const out = await investigate({
          evidence,
          policyDecision: decision,
          deterministicReason: evidence.decision.reason,
          provider,
          model: DEFAULT_OLLAMA_MODEL,
        });

        expect(out.policyDecision, `${decision}/${label}`).toBe(decision);
        expect(out.investigator.authority, `${decision}/${label}`).toBe("ADVISORY_ONLY");
        expect(out.investigator.findings, `${decision}/${label}`).toHaveLength(0);
        expect(["UNAVAILABLE", "INVALID_OUTPUT"]).toContain(out.investigator.status);
      }
    }
  });
});
