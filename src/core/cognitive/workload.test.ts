import { describe, expect, it } from "vitest";

import { classifyWorkload, modelFor, modelRoutesFromEnv } from "./workload";

describe("conversational workload routing (decision 0067 item 6)", () => {
  it("a spoken turn is VOICE whatever it says", () => {
    expect(
      classifyWorkload({ channel: "voice", text: "Analyse pourquoi LDS perd des leads" }),
    ).toBe("VOICE");
  });

  it("a short text exchange is FAST; analysis or long text is DEEP", () => {
    expect(classifyWorkload({ channel: "text", text: "Oui, vas-y." })).toBe("CONVERSATION_FAST");
    expect(classifyWorkload({ channel: "text", text: "Pourquoi LDS perd-il des leads ?" })).toBe(
      "CONVERSATION_DEEP",
    );
    expect(classifyWorkload({ channel: "text", text: "x".repeat(300) })).toBe("CONVERSATION_DEEP");
  });

  it("routes fall back to the default model, and only the default is mandatory", () => {
    expect(modelRoutesFromEnv({})).toBeNull();
    const routes = modelRoutesFromEnv({
      ICOS_COGNITIVE_MODEL: "deep-model",
      ICOS_COGNITIVE_MODEL_FAST: "fast-model",
      ICOS_COGNITIVE_MODEL_VOICE: " ",
    })!;
    expect(modelFor(routes, "CONVERSATION_FAST")).toBe("fast-model");
    expect(modelFor(routes, "CONVERSATION_DEEP")).toBe("deep-model");
    // Blank is unset, not a model id.
    expect(modelFor(routes, "VOICE")).toBe("deep-model");
  });
});
