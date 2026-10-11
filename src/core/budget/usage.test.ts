import { describe, expect, it } from "vitest";

import { MAX_PLAUSIBLE_TOKENS_PER_CALL, readAnthropicStream, readUsage } from "./usage";

const metered = (prompt: number, completion: number, total?: number) =>
  readUsage({
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      ...(total === undefined ? {} : { total_tokens: total }),
    },
  });

describe("readUsage", () => {
  it("lit une consommation OpenAI-compatible complète", () => {
    expect(metered(100, 42, 142)).toEqual({
      kind: "METERED",
      usage: { promptTokens: 100, completionTokens: 42, totalTokens: 142 },
    });
  });

  it("dérive le total quand le fournisseur ne le donne pas", () => {
    expect(metered(10, 5)).toEqual({
      kind: "METERED",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it("accepte un total supérieur à la somme (tokens de raisonnement facturés)", () => {
    const outcome = metered(10, 5, 40);
    expect(outcome).toEqual({
      kind: "METERED",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 40 },
    });
  });

  it("accepte zéro token comme une vraie mesure, pas comme une absence", () => {
    expect(metered(0, 0, 0)).toEqual({
      kind: "METERED",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  });

  it.each([
    ["corps non objet", "nope", "NON_JSON_BODY"],
    ["corps null", null, "NON_JSON_BODY"],
    ["corps tableau", [], "NON_JSON_BODY"],
    ["usage absent", {}, "USAGE_ABSENT"],
    ["usage null", { usage: null }, "USAGE_ABSENT"],
    ["usage non objet", { usage: 12 }, "USAGE_ABSENT"],
    ["prompt_tokens manquant", { usage: { completion_tokens: 1 } }, "USAGE_INCOMPLETE"],
    ["completion_tokens manquant", { usage: { prompt_tokens: 1 } }, "USAGE_INCOMPLETE"],
    [
      "prompt_tokens texte",
      { usage: { prompt_tokens: "10", completion_tokens: 1 } },
      "USAGE_INVALID",
    ],
    [
      "prompt_tokens négatif",
      { usage: { prompt_tokens: -1, completion_tokens: 1 } },
      "USAGE_INVALID",
    ],
    [
      "completion_tokens non entier",
      { usage: { prompt_tokens: 1, completion_tokens: 1.5 } },
      "USAGE_INVALID",
    ],
    ["NaN", { usage: { prompt_tokens: Number.NaN, completion_tokens: 1 } }, "USAGE_INVALID"],
    [
      "Infinity",
      { usage: { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 1 } },
      "USAGE_INVALID",
    ],
    [
      "total_tokens invalide",
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: -3 } },
      "USAGE_INVALID",
    ],
    [
      "total_tokens inférieur à la somme",
      { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 11 } },
      "USAGE_INCONSISTENT",
    ],
    [
      "valeur absurde",
      { usage: { prompt_tokens: MAX_PLAUSIBLE_TOKENS_PER_CALL + 1, completion_tokens: 0 } },
      "USAGE_IMPLAUSIBLE",
    ],
  ])("rend UNMETERED avec un motif : %s", (_label, body, reason) => {
    expect(readUsage(body)).toEqual({ kind: "UNMETERED", reason });
  });

  it("ne rend jamais 0 token pour une absence de mesure", () => {
    const outcome = readUsage({ choices: [] });
    expect(outcome.kind).toBe("UNMETERED");
    expect(outcome).not.toHaveProperty("usage");
  });
});

describe("readUsage — format Anthropic (/v1/messages)", () => {
  it("lit input/output et ajoute les tokens de cache à l'entrée", () => {
    expect(
      readUsage({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      }),
    ).toEqual({
      kind: "METERED",
      usage: { promptTokens: 112, completionTokens: 20, totalTokens: 132 },
    });
  });

  it("une sortie absente n'est pas un zéro", () => {
    expect(readUsage({ usage: { input_tokens: 10 } })).toEqual({
      kind: "UNMETERED",
      reason: "USAGE_INCOMPLETE",
    });
  });

  it("une valeur invalide rend UNMETERED", () => {
    expect(readUsage({ usage: { input_tokens: -1, output_tokens: 2 } })).toMatchObject({
      kind: "UNMETERED",
      reason: "USAGE_INVALID",
    });
  });
});

describe("readAnthropicStream — flux SSE /v1/messages", () => {
  const sse = (...events: unknown[]) =>
    events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

  it("entrée de message_start, sortie CUMULÉE du dernier message_delta, modèle rapporté", () => {
    const text = sse(
      { type: "message_start", message: { model: "m/x", usage: { input_tokens: 40, output_tokens: 1 } } },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 9 } },
      { type: "message_delta", usage: { output_tokens: 15 } },
      { type: "message_stop" },
    );
    expect(readAnthropicStream(text)).toEqual({
      model: "m/x",
      usage: { kind: "METERED", usage: { promptTokens: 40, completionTokens: 15, totalTokens: 55 } },
    });
  });

  it("un flux sans message_start est UNMETERED, jamais 0", () => {
    expect(readAnthropicStream(sse({ type: "ping" })).usage).toEqual({
      kind: "UNMETERED",
      reason: "USAGE_ABSENT",
    });
  });
});
