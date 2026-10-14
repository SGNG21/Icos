import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeWithModelFallback,
  ConversationHttpError,
  ConversationModelsExhaustedError,
  isModelFallbackFailure,
} from "./conversation-model-fallback";

const OPTIONS = { totalTimeoutMs: 5_000, attemptTimeoutMs: 5_000 };
const http = (status: number, model = "m") =>
  new ConversationHttpError(status, model, `HTTP ${status}`);
const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

afterEach(() => vi.restoreAllMocks());

describe("isModelFallbackFailure — 429, 5xx, timeout, and nothing else", () => {
  it.each([429, 500, 502, 503, 504, 599])("HTTP %i moves to the next model", (status) => {
    expect(isModelFallbackFailure(http(status))).toBe(true);
  });
  it.each([400, 401, 403, 404, 422, 600])("HTTP %i does not", (status) => {
    expect(isModelFallbackFailure(http(status))).toBe(false);
  });
  it("a timeout does; a budget refusal, a plain error and a cancellation do not", () => {
    expect(isModelFallbackFailure(timeout())).toBe(true);
    expect(
      isModelFallbackFailure(Object.assign(new Error("x"), { name: "BudgetDeniedError" })),
    ).toBe(false);
    expect(isModelFallbackFailure(new Error("OmniRoute chat HTTP 503"))).toBe(false);
    expect(isModelFallbackFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(
      false,
    );
  });
});

describe("completeWithModelFallback", () => {
  it("answers with the first model that succeeds, in list order, and says it fell back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tried: string[] = [];
    const out = await completeWithModelFallback(
      ["a", "b", "c"],
      async (model) => {
        tried.push(model);
        if (model === "a") throw http(429, model);
        return `answer:${model}`;
      },
      OPTIONS,
    );
    expect(out).toBe("answer:b");
    expect(tried).toEqual(["a", "b"]);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "CONVERSATION_MODEL_FALLBACK",
      from: "a",
      failure: "HTTP 429",
      to: "b",
    });
  });

  it("a timeout moves on too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await completeWithModelFallback(
      ["a", "b"],
      async (model) => {
        if (model === "a") throw timeout();
        return model;
      },
      OPTIONS,
    );
    expect(out).toBe("b");
  });

  it("a non-fallback failure is thrown AT ONCE, untouched, and the next model is never tried", async () => {
    const tried: string[] = [];
    const refused = http(401);
    await expect(
      completeWithModelFallback(
        ["a", "b"],
        async (model) => {
          tried.push(model);
          throw refused;
        },
        OPTIONS,
      ),
    ).rejects.toBe(refused);
    expect(tried).toEqual(["a"]);
  });

  it("an exhausted list is a NAMED error listing every attempt — no implicit last resort", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tried: string[] = [];
    const error = await completeWithModelFallback(
      ["a", "b"],
      async (model) => {
        tried.push(model);
        throw http(model === "a" ? 502 : 503, model);
      },
      OPTIONS,
    ).catch((e: unknown) => e);
    expect(tried).toEqual(["a", "b"]);
    expect(error).toBeInstanceOf(ConversationModelsExhaustedError);
    expect((error as Error).name).toBe("ConversationModelsExhaustedError");
    expect((error as Error).message).toBe(
      "CONVERSATION_MODELS_EXHAUSTED: a → HTTP 502 | b → HTTP 503",
    );
  });

  it("the caller's cancellation stops the chain", async () => {
    const controller = new AbortController();
    const tried: string[] = [];
    await expect(
      completeWithModelFallback(
        ["a", "b"],
        async (model) => {
          tried.push(model);
          controller.abort();
          throw timeout();
        },
        { ...OPTIONS, signal: controller.signal },
      ),
    ).rejects.toThrow("timed out");
    expect(tried).toEqual(["a"]);
  });

  it("each attempt gets a signal bounded by the attempt timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await completeWithModelFallback(
      ["slow", "fast"],
      (model, signal) =>
        model === "fast"
          ? Promise.resolve(model)
          : new Promise<string>((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason)),
            ),
      { totalTimeoutMs: 5_000, attemptTimeoutMs: 20 },
    );
    expect(out).toBe("fast");
  });

  it("the whole chain never outlives the total budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tried: string[] = [];
    const error = await completeWithModelFallback(
      ["a", "b"],
      (model, signal) => {
        tried.push(model);
        return new Promise<string>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
      { totalTimeoutMs: 20, attemptTimeoutMs: 5_000 },
    ).catch((e: unknown) => e);
    expect(tried).toEqual(["a"]);
    expect(error).toBeInstanceOf(ConversationModelsExhaustedError);
  });
});
