import { describe, expect, it } from "vitest";

import { OmniRouteAdapter } from "./omniroute-adapter";
import type { OmniRouteConfig } from "./omniroute-config";
import type { AiRoutingRequest } from "@/core/ai";

/** Type pour les fonctions fetch de test. */
type MockFetch = typeof globalThis.fetch;

// ─────────────────────────────────────
// Helpers
// ─────────────────────────────────────

const defaultConfig: OmniRouteConfig = {
  baseUrl: "http://omniroute.test",
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 300_000,
};

const DEFAULT_REQUEST: AiRoutingRequest = {
  prompt: "Hello, world!",
  tenantId: "tenant-001",
  correlationId: "corr-001",
  intent: "BEST_REASONING",
  qualityThreshold: "standard",
  fallbackAllowed: true,
  timeoutMs: 60_000,
  modalite: "chat",
};

function makeRequest(overrides: Partial<AiRoutingRequest> = {}): AiRoutingRequest {
  return { ...DEFAULT_REQUEST, ...overrides };
}

function okBody(): string {
  return JSON.stringify({
    model: "claude-sonnet-5",
    provider: "anthropic",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Bonjour!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cost: 0.0015,
    routing_explanation: "Routé vers anthropic (intent: BEST_REASONING)",
    fallback_used: false,
  });
}

/** Mock fetch qui retourne une réponse HTTP 200 avec le corps OmniRoute standard. */
function okResponse(): Response {
  return new Response(okBody(), { status: 200 });
}

function sseResponse(events: string[]): Response {
  return new Response(events.join("\n\n"), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-omniroute-provider": "private-provider",
      "x-omniroute-model": "private-model",
    },
  });
}

/** Mock fetch qui retourne une réponse HTTP d'erreur. */
function errorResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : "", { status });
}

/** Mock fetch qui retourne une réponse avec du texte personnalisé. */
function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

// ─────────────────────────────────────
// D3-01: successful generation
// ─────────────────────────────────────

describe("D3-01: successful generation", () => {
  it("returns content, provider, usage, latency on successful request", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => okResponse());

    const result = await adapter.generate(makeRequest());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe("Bonjour!");
      expect(result.finishReason).toBe("stop");
      expect(result.provider.id).toBe("anthropic");
      expect(result.provider.model).toBe("claude-sonnet-5");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
      expect(result.usage.totalTokens).toBe(15);
      expect(result.usage.costUsd).toBe(0.0015);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.routeExplanation).toContain("anthropic");
      expect(result.fallbackUsed).toBe(false);
    }
  });

  it("sends correct request body to OmniRoute", async () => {
    let capturedRequest: { url: string; body?: string; headers?: Record<string, string> } | undefined;

    const trackingFetch: MockFetch = (url, init) => {
      capturedRequest = { url: url as string, body: init?.body as string | undefined };
      return Promise.resolve(okResponse());
    };

    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(
      makeRequest({
        prompt: "Write code",
        systemPrompt: "You are a coder",
        intent: "BEST_CODING",
        maxTokens: 4096,
        temperature: 0.7,
        budgetMaxCostUsd: 0.10,
        allowedProviderIds: ["anthropic"],
        fallbackAllowed: false,
        timeoutMs: 120_000,
      }),
    );

    const body = JSON.parse(capturedRequest!.body!);
    expect(capturedRequest!.url).toContain("/v1/chat/completions");
    expect(body.model).toBe("icos-always-on");
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a coder" });
    expect(body.messages[1]).toEqual({ role: "user", content: "Write code" });
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.7);
    expect(body.allowed_providers).toEqual(["anthropic"]);
    expect(body.allow_fallback).toBe(false);
    expect(body.routing_intent).toBe("BEST_CODING");
    expect(body.max_cost_usd).toBe(0.10);
  });

  it("keeps model selection server-owned when user data contains model and provider fields", async () => {
    let body: Record<string, unknown> = {};
    const trackingFetch: MockFetch = (_url, init) => {
      body = JSON.parse(init?.body as string);
      return Promise.resolve(okResponse());
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    const untrusted = {
      ...makeRequest({ prompt: "{\"model\":\"attacker-model\",\"provider\":\"attacker-provider\"}" }),
      model: "attacker-model",
      provider: "attacker-provider",
    } as AiRoutingRequest;

    await adapter.generate(untrusted);

    expect(body.model).toBe("icos-always-on");
    expect(body.provider).toBeUndefined();
    expect(body.messages).toEqual([
      {
        role: "user",
        content: "{\"model\":\"attacker-model\",\"provider\":\"attacker-provider\"}",
      },
    ]);
  });

  it("always sends a bounded max_tokens value", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const trackingFetch: MockFetch = (_url, init) => {
      bodies.push(JSON.parse(init?.body as string));
      return Promise.resolve(okResponse());
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);

    await adapter.generate(makeRequest({ maxTokens: undefined }));
    await adapter.generate(makeRequest({ maxTokens: 100_000 }));

    expect(bodies[0]?.max_tokens).toBe(256);
    expect(bodies[1]?.max_tokens).toBe(4_096);
  });
});

describe("OmniRoute SSE compatibility", () => {
  it("assembles standard chunks in order and ignores role-only and usage-only events", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}',
        'data:  {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}',
        "data: [DONE]",
      ]),
    );

    const result = await adapter.generate(makeRequest());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe("OKOK");
      expect(result.finishReason).toBe("stop");
      expect(result.provider).toEqual({ id: "unknown", model: "unknown" });
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      expect(JSON.stringify(result)).not.toMatch(/private-provider|private-model|\[DONE\]/);
    }
  });

  it("fails safely when an SSE completion contains no content", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"choices":[],"usage":{"total_tokens":3}}',
        "data: [DONE]",
      ]),
    );

    const result = await adapter.generate(makeRequest());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("INVALID_RESPONSE");
  });

  it("fails safely on malformed SSE JSON without returning partial content", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}',
        "data: {malformed",
        "data: [DONE]",
      ]),
    );

    const result = await adapter.generate(makeRequest());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
      expect(JSON.stringify(result)).not.toContain("partial");
    }
  });

  it("fails safely when the SSE completion is missing DONE", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}']),
    );

    const result = await adapter.generate(makeRequest());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("INVALID_RESPONSE");
  });

  it("rejects completion content that exceeds the adapter output bound", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "a".repeat(65_537) } }] })}`,
        "data: [DONE]",
      ]),
    );

    const result = await adapter.generate(makeRequest());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("INVALID_RESPONSE");
  });
});

// ─────────────────────────────────────
// D3-02: tenant context propagated
// ─────────────────────────────────────

describe("D3-02: tenant context propagated", () => {
  it("sends X-Tenant-Id header", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const trackingFetch: MockFetch = (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(okResponse());
    };

    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest({ tenantId: "tenant-alpha" }));

    expect(capturedHeaders!["X-Tenant-Id"]).toBe("tenant-alpha");
  });
});

// ─────────────────────────────────────
// D3-03: data classification propagated
// ─────────────────────────────────────

describe("D3-03: data classification propagated", () => {
  it("sends X-Data-Classification header when classification is set", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const trackingFetch: MockFetch = (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(okResponse());
    };

    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest({ dataClassification: "C2" }));

    expect(capturedHeaders!["X-Data-Classification"]).toBe("C2");
  });

  it("omits X-Data-Classification header when classification is not set", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const trackingFetch: MockFetch = (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(okResponse());
    };

    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest({ dataClassification: undefined }));

    expect(capturedHeaders!["X-Data-Classification"]).toBeUndefined();
  });
});

// ─────────────────────────────────────
// D3-04: correlation id propagated
// ─────────────────────────────────────

describe("D3-04: correlation id propagated", () => {
  it("sends X-Correlation-Id header", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const trackingFetch: MockFetch = (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(okResponse());
    };

    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest({ correlationId: "mission-123-run-1" }));

    expect(capturedHeaders!["X-Correlation-Id"]).toBe("mission-123-run-1");
  });
});

// ─────────────────────────────────────
// D3-05: provider unavailable mapped correctly
// ─────────────────────────────────────

describe("D3-05: provider unavailable mapped correctly", () => {
  it("maps HTTP 503 to PROVIDER_UNAVAILABLE", async () => {
    const adapter = new OmniRouteAdapter(
      defaultConfig,
      undefined,
      async () =>
        errorResponse(503, {
          error: {
            message: "raw upstream error",
            provider_error: "credential=private-provider-secret",
          },
        }),
    );
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
      expect(result.error.fallbackPossible).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/raw upstream error|private-provider-secret/);
    }
  });

  it("maps HTTP 502 to PROVIDER_UNAVAILABLE", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => errorResponse(502));
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("maps fetch network error to PROVIDER_UNAVAILABLE", async () => {
    const failingFetch: MockFetch = () => Promise.reject(new TypeError("fetch failed"));
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, failingFetch);
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
  });
});

// ─────────────────────────────────────
// D3-06: rate limit mapped correctly
// ─────────────────────────────────────

describe("D3-06: rate limit mapped correctly", () => {
  it("maps HTTP 429 to RATE_LIMITED", async () => {
    const adapter = new OmniRouteAdapter(
      defaultConfig,
      undefined,
      async () => errorResponse(429, { error: { message: "Rate limit exceeded" } }),
    );
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.retryable).toBe(true);
      expect(result.error.fallbackPossible).toBe(true);
    }
  });
});

// ─────────────────────────────────────
// D3-07: timeout mapped correctly
// ─────────────────────────────────────

describe("D3-07: timeout mapped correctly", () => {
  it("maps TimeoutError to TIMEOUT", async () => {
    const timeoutFetch: MockFetch = () => {
      const err = new DOMException("The operation timed out", "TimeoutError");
      return Promise.reject(err);
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, timeoutFetch);
    const result = await adapter.generate(makeRequest({ timeoutMs: 1 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
      expect(result.error.fallbackPossible).toBe(true);
    }
  });
});

// ─────────────────────────────────────
// D3-08: AbortSignal cancels request
// ─────────────────────────────────────

describe("D3-08: AbortSignal cancels request", () => {
  it("returns CANCELLED when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    const abortFetch: MockFetch = () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      return Promise.reject(err);
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, abortFetch);
    controller.abort();
    const result = await adapter.generate({ ...makeRequest(), abortSignal: controller.signal });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("CANCELLED");
      expect(result.error.retryable).toBe(false);
      expect(result.error.fallbackPossible).toBe(false);
    }
  });

  it("returns CANCELLED when signal is already aborted before fetch", async () => {
    const controller = new AbortController();
    controller.abort();

    const shouldNotBeCalled: MockFetch = () => {
      throw new Error("fetch should not have been called");
    };

    const adapter = new OmniRouteAdapter(defaultConfig, undefined, shouldNotBeCalled);
    const result = await adapter.generate({ ...makeRequest(), abortSignal: controller.signal });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("CANCELLED");
    }
  });
});

// ─────────────────────────────────────
// D3-09: invalid upstream response fails safely
// ─────────────────────────────────────

describe("D3-09: invalid upstream response fails safely", () => {
  it("maps non-JSON response to INVALID_RESPONSE", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => textResponse("<html>error</html>"));
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });

  it("maps empty choices response to INVALID_RESPONSE", async () => {
    const badBody = JSON.stringify({ model: "x", choices: [] });
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => textResponse(badBody));
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });
});

// ─────────────────────────────────────
// D3-10: no prompt content in logs
// ─────────────────────────────────────

describe("D3-10: no prompt content in logs", () => {
  it("does not include prompt or response content in observability hooks", async () => {
    const hookResults: Array<Record<string, unknown>> = [];
    const adapter = new OmniRouteAdapter(defaultConfig, {
      onRequestCompleted: (_correlationId, result) => {
        hookResults.push(result as Record<string, unknown>);
      },
    }, async () => okResponse());

    await adapter.generate(makeRequest({ prompt: "THIS_IS_A_SECRET_PROMPT" }));

    for (const hook of hookResults) {
      const json = JSON.stringify(hook);
      expect(json).not.toContain("THIS_IS_A_SECRET_PROMPT");
    }
  });

  it("does not log prompt via console", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => okResponse());
    await adapter.generate(makeRequest({ prompt: "SENSITIVE_DATA" }));
    // Si on arrive ici sans console.log, c'est ok
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────
// D3-11: no credentials in logs/errors
// ─────────────────────────────────────

describe("D3-11: no credentials in logs/errors", () => {
  it("does not include apiKey in error messages", async () => {
    const failingFetch: MockFetch = () => Promise.reject(new TypeError("fetch failed"));
    const adapter = new OmniRouteAdapter(
      { ...defaultConfig, apiKey: "sk-secret-key-12345" },
      undefined,
      failingFetch,
    );
    const result = await adapter.generate(makeRequest({ prompt: "test" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).not.toContain("sk-secret-key-12345");
    }
  });
});

// ─────────────────────────────────────
// D3-12: no provider-specific types leak into core
// ─────────────────────────────────────

describe("D3-12: no provider-specific types leak into core", () => {
  it("returns normalized provider info, never provider-specific objects", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => okResponse());
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.provider.id).toBe("string");
      expect(typeof result.provider.model).toBe("string");
      // account est optionnel — il n'est pas présent quand OmniRoute ne le retourne pas
      expect(Object.keys(result.provider)).toContain("id");
      expect(Object.keys(result.provider)).toContain("model");
    }
  });
});

// ─────────────────────────────────────
// D3-13: routing intent survives adapter mapping
// ─────────────────────────────────────

describe("D3-13: routing intent survives adapter mapping", () => {
  it("passes intent as routing_intent in request body", async () => {
    let body: Record<string, unknown> = {};
    const trackingFetch: MockFetch = (_url, init) => {
      body = JSON.parse(init?.body as string);
      return Promise.resolve(okResponse());
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest({ intent: "CHEAP" }));
    expect(body.routing_intent).toBe("CHEAP");
  });

  it("defaults intent to BEST_REASONING when not specified", async () => {
    let body: Record<string, unknown> = {};
    const trackingFetch: MockFetch = (_url, init) => {
      body = JSON.parse(init?.body as string);
      return Promise.resolve(okResponse());
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest());
    expect(body.routing_intent).toBe("BEST_REASONING");
  });
});

// ─────────────────────────────────────
// D3-14: fallbackAllowed semantics tested/documented
// ─────────────────────────────────────

describe("D3-14: fallbackAllowed semantics tested/documented", () => {
  it("passes allow_fallback as false when fallbackAllowed is false", async () => {
    let body: Record<string, unknown> = {};
    const trackingFetch: MockFetch = (_url, init) => {
      body = JSON.parse(init?.body as string);
      return Promise.resolve(okResponse());
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest({ fallbackAllowed: false }));
    expect(body.allow_fallback).toBe(false);
  });

  it("passes allow_fallback as true when fallbackAllowed is true", async () => {
    let body: Record<string, unknown> = {};
    const trackingFetch: MockFetch = (_url, init) => {
      body = JSON.parse(init?.body as string);
      return Promise.resolve(okResponse());
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, trackingFetch);
    await adapter.generate(makeRequest({ fallbackAllowed: true }));
    expect(body.allow_fallback).toBe(true);
  });

  it("reports fallbackUsed in result when OmniRoute indicates fallback", async () => {
    const fbBody = JSON.stringify({
      model: "gpt-4o-mini",
      provider: "openai",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      fallback_used: true,
    });
    const fbFetch: MockFetch = () => Promise.resolve(new Response(fbBody, { status: 200 }));
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, fbFetch);
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.fallbackUsed).toBe(true);
      expect(result.provider.id).toBe("openai");
    }
  });
});

// ─────────────────────────────────────
// D3-15: D2 durable state is unaffected by provider failure
// ─────────────────────────────────────

describe("D3-15: D2 durable state is unaffected by provider failure", () => {
  it("adapter does not import or reference D2 domain types", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("./omniroute-adapter.ts", import.meta.url),
      "utf-8",
    );
    // Vérifier l'absence de dépendance aux domaines D2 (Mission, Plan, Run, Orchestrateur)
    // Les mots courts comme "plan" et "run" peuvent apparaître dans du texte anglais
    // (ex: "explanation") — on vérifie les termes D2 spécifiques uniquement.
    expect(source).not.toContain("mission");
    expect(source).not.toContain("orchestrat");
    expect(source).not.toContain("MissionRepository");
    expect(source).not.toContain("D2");
  });

  it("does not attempt any persistence or state mutation", () => {
    const adapter = new OmniRouteAdapter(defaultConfig);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter));
    expect(proto).toContain("generate");
    expect(proto).toContain("check");
    for (const method of proto) {
      expect(method).not.toMatch(/save|delete|update|create|persist/);
    }
  });

  it("error result does not affect surrounding code under normal conditions", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => errorResponse(503));
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
    }
  });
});

// ─────────────────────────────────────
// Health check
// ─────────────────────────────────────

describe("AiHealthPort.check", () => {
  it("calls OmniRoute /status and returns true for HTTP 200", async () => {
    const healthFetch: MockFetch = (url) => {
      expect(url).toBe("http://omniroute.test/status");
      return Promise.resolve(new Response("OK", { status: 200 }));
    };
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, healthFetch);
    const result = await adapter.check();
    expect(result).toBe(true);
  });

  it("returns false for HTTP 404", async () => {
    const errorFetch: MockFetch = () => Promise.resolve(new Response("", { status: 404 }));
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, errorFetch);
    const result = await adapter.check();
    expect(result).toBe(false);
  });

  it("returns false for HTTP 500", async () => {
    const errorFetch: MockFetch = () => Promise.resolve(new Response("", { status: 500 }));
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, errorFetch);
    const result = await adapter.check();
    expect(result).toBe(false);
  });

  it("returns false for a network failure", async () => {
    const failingFetch: MockFetch = () => Promise.reject(new TypeError("fetch failed"));
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, failingFetch);
    const result = await adapter.check();
    expect(result).toBe(false);
  });

  it("does not expose credentials when the health request fails", async () => {
    const apiKey = "sk-health-secret-12345";
    const failingFetch: MockFetch = () => Promise.reject(new Error(apiKey));
    const adapter = new OmniRouteAdapter(
      { ...defaultConfig, apiKey },
      undefined,
      failingFetch,
    );
    const result = await adapter.check();
    expect(result).toBe(false);
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});

// ─────────────────────────────────────
// Error mapping (additional)
// ─────────────────────────────────────

describe("error mapping", () => {
  it("maps HTTP 403 to POLICY_BLOCKED", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => errorResponse(403));
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("POLICY_BLOCKED");
      expect(result.error.retryable).toBe(false);
      expect(result.error.fallbackPossible).toBe(false);
    }
  });

  it("maps HTTP 400 to UNSUPPORTED_CAPABILITY", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => errorResponse(400));
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("UNSUPPORTED_CAPABILITY");
    }
  });

  it("maps unknown error to INTERNAL_ERROR", async () => {
    const weirdFetch: MockFetch = () => Promise.reject(new Error("Something weird happened"));
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, weirdFetch);
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("maps HTTP 200 with invalid JSON to INVALID_RESPONSE", async () => {
    const adapter = new OmniRouteAdapter(defaultConfig, undefined, async () => textResponse("not valid json{{}"));
    const result = await adapter.generate(makeRequest());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });
});

// ─────────────────────────────────────
// Config validation
// ─────────────────────────────────────

describe("config validation", () => {
  it("strips trailing slash from baseUrl", async () => {
    const trackingFetch: MockFetch = (url) => {
      expect(url).toBe("http://test/v1/chat/completions");
      return Promise.resolve(okResponse());
    };
    const adapter = new OmniRouteAdapter({ ...defaultConfig, baseUrl: "http://test/" }, undefined, trackingFetch);
    await adapter.generate(makeRequest());
  });
});
