import { describe, expect, it } from "vitest";

import {
  cognitionModelChain,
  ConversationModelConfigError,
  conversationModelPlan,
  DEFAULT_CONVERSATION_MODELS,
  explicitConversationModels,
} from "./conversation-models";

const SUPER = "nvidia/nvidia/nemotron-3-super-120b-a12b";
const ULTRA = "nvidia/nvidia/nemotron-3-ultra-550b-a55b";

describe("conversationModelPlan — an explicit, ordered list of concrete models", () => {
  it("defaults to the measured free NVIDIA pair, super first, never a meta-route", () => {
    expect(DEFAULT_CONVERSATION_MODELS).toEqual([SUPER, ULTRA]);
    expect(conversationModelPlan({})).toEqual({
      models: [SUPER, ULTRA],
      source: "DEFAULT_MEASURED_FREE",
    });
  });

  it("ICOS_CONVERSATION_MODELS wins, trimmed, in the operator's order", () => {
    expect(
      conversationModelPlan({
        ICOS_CONVERSATION_MODELS: ` ${ULTRA} , cc/claude-sonnet-5 `,
        ICOS_CEO_MODEL: SUPER,
      }),
    ).toEqual({ models: [ULTRA, "cc/claude-sonnet-5"], source: "ICOS_CONVERSATION_MODELS" });
  });

  it("COMPATIBILITY: an explicitly configured ICOS_CEO_MODEL is honoured ALONE", () => {
    expect(conversationModelPlan({ ICOS_CEO_MODEL: "cc/claude-sonnet-5" })).toEqual({
      models: ["cc/claude-sonnet-5"],
      source: "ICOS_CEO_MODEL",
    });
  });

  it("COMPATIBILITY: ICOS_REVIEWER_MODEL is the CEO's model when nothing else is set", () => {
    expect(conversationModelPlan({ ICOS_REVIEWER_MODEL: ULTRA })).toEqual({
      models: [ULTRA],
      source: "ICOS_REVIEWER_MODEL",
    });
  });

  it("a blank variable is absent", () => {
    expect(
      conversationModelPlan({ ICOS_CONVERSATION_MODELS: " ", ICOS_CEO_MODEL: "" }).source,
    ).toBe("DEFAULT_MEASURED_FREE");
  });

  it.each([
    [{ ICOS_CEO_MODEL: "auto/best-chat" }, "ICOS_CEO_MODEL"],
    [{ ICOS_CEO_MODEL: "auto/nvidia-chat" }, "ICOS_CEO_MODEL"],
    [{ ICOS_REVIEWER_MODEL: "openrouter/auto" }, "ICOS_REVIEWER_MODEL"],
    [{ ICOS_CONVERSATION_MODELS: `${SUPER},auto/best-free` }, "ICOS_CONVERSATION_MODELS"],
    [{ ICOS_CONVERSATION_MODELS: `${SUPER},openrouter/ auto` }, "ICOS_CONVERSATION_MODELS"],
    [{ ICOS_CONVERSATION_MODELS: "cu /auto" }, "ICOS_CONVERSATION_MODELS"],
    [{ ICOS_CEO_MODEL: "openrouter / auto" }, "ICOS_CEO_MODEL"],
    /* A meta-route is refused even where a higher-precedence variable would win. */
    [{ ICOS_CONVERSATION_MODELS: SUPER, ICOS_CEO_MODEL: "auto/best-chat" }, "ICOS_CEO_MODEL"],
  ])("refuses a meta-route with the variable's name: %j", (env, variable) => {
    expect(() => conversationModelPlan(env)).toThrow(ConversationModelConfigError);
    expect(() => conversationModelPlan(env)).toThrow(
      new RegExp(`^CONVERSATION_MODEL_NOT_ADMISSIBLE:${variable} `),
    );
  });

  it.each([
    [`${SUPER},,${ULTRA}`, /entrée vide/],
    [`${SUPER},${SUPER}`, /en double/],
  ])("refuses an ambiguous list %s instead of guessing", (value, reason) => {
    expect(() => explicitConversationModels({ ICOS_CONVERSATION_MODELS: value })).toThrow(reason);
  });
});

describe("cognitionModelChain — fallback only within the explicit list", () => {
  it("primary first, then the list in order, without repeating the primary", () => {
    expect(cognitionModelChain(ULTRA, [SUPER, ULTRA, "x/y"])).toEqual([ULTRA, SUPER, "x/y"]);
  });

  it("no explicit list ⇒ no fallback", () => {
    expect(cognitionModelChain(ULTRA, [])).toEqual([ULTRA]);
  });
});
