import { describe, expect, it } from "vitest";

import { aiErrorCodeSchema, aiGenerationResultSchema, aiProviderInfoSchema, aiRoutingIntentSchema, aiRoutingRequestSchema, aiUsageSchema } from "./contract";

describe("AiRoutingIntentSchema", () => {
  it("accepts all valid intents", () => {
    const valid = ["BEST_REASONING", "BEST_CODING", "FAST", "CHEAP", "PRIVATE", "FALLBACK"] as const;
    for (const v of valid) {
      expect(aiRoutingIntentSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown intent", () => {
    expect(() => aiRoutingIntentSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("AiErrorCodeSchema", () => {
  it("accepts all valid codes", () => {
    const valid = [
      "PROVIDER_UNAVAILABLE",
      "RATE_LIMITED",
      "TIMEOUT",
      "INVALID_RESPONSE",
      "POLICY_BLOCKED",
      "UNSUPPORTED_CAPABILITY",
      "CANCELLED",
      "INTERNAL_ERROR",
    ] as const;
    for (const v of valid) {
      expect(aiErrorCodeSchema.parse(v)).toBe(v);
    }
  });
});

describe("AiProviderInfoSchema", () => {
  it("accepts valid provider info", () => {
    const result = aiProviderInfoSchema.parse({ id: "anthropic", model: "claude-sonnet-5" });
    expect(result.id).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-5");
  });

  it("accepts provider info with account", () => {
    const result = aiProviderInfoSchema.parse({ id: "openai", model: "gpt-4o", account: "org-dev" });
    expect(result.account).toBe("org-dev");
  });

  it("rejects empty provider id", () => {
    expect(() => aiProviderInfoSchema.parse({ id: "", model: "gpt-4o" })).toThrow();
  });
});

describe("AiUsageSchema", () => {
  it("accepts valid usage", () => {
    const result = aiUsageSchema.parse({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(result.totalTokens).toBe(150);
  });

  it("accepts usage with cost", () => {
    const result = aiUsageSchema.parse({ inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.015 });
    expect(result.costUsd).toBe(0.015);
  });

  it("rejects negative tokens", () => {
    expect(() => aiUsageSchema.parse({ inputTokens: -1, outputTokens: 50, totalTokens: 49 })).toThrow();
  });
});

describe("AiGenerationResultSchema", () => {
  it("validates successful result", () => {
    const result = aiGenerationResultSchema.parse({
      success: true,
      content: "Hello!",
      finishReason: "stop",
      provider: { id: "anthropic", model: "claude-sonnet-5" },
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      latencyMs: 1200,
      fallbackUsed: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe("Hello!");
    }
  });

  it("validates error result", () => {
    const result = aiGenerationResultSchema.parse({
      success: false,
      error: { code: "PROVIDER_UNAVAILABLE", message: "Provider is down", retryable: true, fallbackPossible: true },
      latencyMs: 5000,
      fallbackUsed: false,
    });
    expect(result.success).toBe(false);
  });

  it("validates error result with all fields", () => {
    const result = aiGenerationResultSchema.parse({
      success: false,
      error: { code: "TIMEOUT", message: "Request timed out", retryable: true, fallbackPossible: true },
      latencyMs: 60000,
      provider: { id: "openai", model: "gpt-4o" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      fallbackUsed: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.provider?.id).toBe("openai");
    }
  });

  it("rejects result with missing fields", () => {
    expect(() =>
      aiGenerationResultSchema.parse({
        success: true,
        // missing content
        provider: { id: "a", model: "b" },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      })
    ).toThrow();
  });
});

describe("AiRoutingRequestSchema", () => {
  it("validates minimal request", () => {
    const result = aiRoutingRequestSchema.parse({
      prompt: "Hello",
      tenantId: "tenant-001",
      correlationId: "corr-001",
    });
    expect(result.prompt).toBe("Hello");
    expect(result.tenantId).toBe("tenant-001");
    expect(result.intent).toBe("BEST_REASONING");
    expect(result.timeoutMs).toBe(60_000);
    expect(result.fallbackAllowed).toBe(true);
    expect(result.qualityThreshold).toBe("standard");
    expect(result.modalite).toBe("chat");
  });

  it("validates full request", () => {
    const result = aiRoutingRequestSchema.parse({
      prompt: "Write code",
      systemPrompt: "You are a coder",
      intent: "BEST_CODING",
      tenantId: "tenant-002",
      dataClassification: "C0",
      maxTokens: 4096,
      temperature: 0.7,
      budgetMaxCostUsd: 0.10,
      qualityThreshold: "high",
      allowedProviderIds: ["anthropic"],
      fallbackAllowed: false,
      timeoutMs: 120_000,
      correlationId: "corr-002",
      modalite: "chat",
    });
    expect(result.intent).toBe("BEST_CODING");
    expect(result.dataClassification).toBe("C0");
    expect(result.fallbackAllowed).toBe(false);
    expect(result.budgetMaxCostUsd).toBe(0.10);
  });

  it("rejects empty prompt", () => {
    expect(() =>
      aiRoutingRequestSchema.parse({
        prompt: "",
        tenantId: "tenant-001",
        correlationId: "corr-001",
      })
    ).toThrow();
  });

  it("rejects negative timeout", () => {
    expect(() =>
      aiRoutingRequestSchema.parse({
        prompt: "Hello",
        tenantId: "tenant-001",
        correlationId: "corr-001",
        timeoutMs: -1,
      })
    ).toThrow();
  });

  it("rejects invalid temperature", () => {
    expect(() =>
      aiRoutingRequestSchema.parse({
        prompt: "Hello",
        tenantId: "tenant-001",
        correlationId: "corr-001",
        temperature: 3,
      })
    ).toThrow();
  });
});
