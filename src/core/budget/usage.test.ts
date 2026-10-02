import { describe, expect, it } from "vitest";

import { MAX_PLAUSIBLE_TOKENS_PER_CALL, readUsage } from "./usage";

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
