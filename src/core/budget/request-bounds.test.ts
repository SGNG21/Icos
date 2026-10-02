import { describe, expect, it } from "vitest";

import {
  boundCompletionBody,
  CHAT_TEMPLATE_HEADROOM_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "./request-bounds";

/** Ce que la couture lira dans le corps borné. */
const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

describe("boundCompletionBody — aucune sortie sans borne (verrou C1)", () => {
  it("INJECTE une limite de sortie quand l'appelant n'en déclare aucune", () => {
    /* Le corps exact du planificateur : aucun `max_tokens`. C'était le défaut CRITIQUE. */
    const planner = JSON.stringify({ model: "m", messages: [{ role: "user", content: "salut" }] });
    const bounded = boundCompletionBody(planner, DEFAULT_MAX_OUTPUT_TOKENS);

    expect(bounded.kind).toBe("BOUNDED");
    if (bounded.kind !== "BOUNDED") return;
    expect(parse(bounded.body).max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(bounded.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("RABAISSE une limite déclarée trop haute, et ne relève JAMAIS une limite basse", () => {
    const high = boundCompletionBody(JSON.stringify({ max_tokens: 99_999 }), 1_000);
    const low = boundCompletionBody(JSON.stringify({ max_tokens: 7 }), 1_000);

    expect(high.kind === "BOUNDED" && high.maxOutputTokens).toBe(1_000);
    expect(low.kind === "BOUNDED" && low.maxOutputTokens).toBe(7);
  });

  it("rabaisse AUSSI `max_completion_tokens`, sans jamais l'introduire", () => {
    const both = boundCompletionBody(JSON.stringify({ max_completion_tokens: 5_000 }), 100);
    expect(both.kind === "BOUNDED" && parse(both.body).max_completion_tokens).toBe(100);
    expect(both.kind === "BOUNDED" && parse(both.body).max_tokens).toBe(100);

    const absent = boundCompletionBody(JSON.stringify({ model: "m" }), 100);
    expect(absent.kind === "BOUNDED" && "max_completion_tokens" in parse(absent.body)).toBe(false);
  });

  it("prend la PLUS PETITE des deux orthographes : réduire, toujours", () => {
    const mixed = boundCompletionBody(
      JSON.stringify({ max_tokens: 900, max_completion_tokens: 40 }),
      1_000,
    );
    expect(mixed.kind === "BOUNDED" && mixed.maxOutputTokens).toBe(40);
  });

  it("MAJORE l'entrée par les octets du corps : une vraie borne, pas une estimation", () => {
    /*
     * Un token vaut au moins un octet dans tout tokenizer BPE sur de l'UTF-8, donc
     * `octets(corps)` majore `tokens(prompt)`. Une heuristique `longueur / 4` pourrait
     * SOUS-estimer et rouvrirait le dépassement — on ne l'utilise pas.
     */
    const bounded = boundCompletionBody(JSON.stringify({ max_tokens: 10, m: "é".repeat(100) }), 50);
    expect(bounded.kind).toBe("BOUNDED");
    if (bounded.kind !== "BOUNDED") return;
    expect(bounded.promptCeilingTokens).toBe(
      Buffer.byteLength(bounded.body, "utf8") + CHAT_TEMPLATE_HEADROOM_TOKENS,
    );
    expect(bounded.reservedTokens).toBe(bounded.promptCeilingTokens + 10);
    /* Les deux octets d'un « é » sont bien comptés : la borne ne dépend pas du nombre de chars. */
    expect(bounded.promptCeilingTokens).toBeGreaterThan(200 + CHAT_TEMPLATE_HEADROOM_TOKENS);
  });

  it("REFUSE tout corps dont on ne peut pas borner la sortie, au lieu de le laisser partir", () => {
    for (const body of [
      undefined,
      null,
      42,
      new URLSearchParams(),
      "pas du json",
      "[1,2]",
      '"x"',
    ]) {
      expect(boundCompletionBody(body, 100).kind).toBe("UNBOUNDABLE");
    }
  });

  it("REFUSE une limite déclarée absurde plutôt que de la corriger en silence", () => {
    /* Corps BRUTS : certaines de ces valeurs ne survivent pas à `JSON.stringify`. */
    for (const bad of ["0", "-1", "1.5", '"beaucoup"', "1e309", "true"]) {
      const outcome = boundCompletionBody(`{"max_tokens":${bad}}`, 100);
      expect(outcome.kind, bad).toBe("UNBOUNDABLE");
    }
  });

  it("`max_tokens: null` veut dire SANS LIMITE chez le fournisseur : on en impose une", () => {
    /*
     * Ce n'est PAS une valeur absurde à refuser, c'est la forme la plus dangereuse de
     * l'absence de borne — explicitement illimitée. On l'ÉCRASE par le plafond.
     */
    const bounded = boundCompletionBody('{"max_tokens":null}', 100);
    expect(bounded.kind === "BOUNDED" && bounded.maxOutputTokens).toBe(100);
    expect(bounded.kind === "BOUNDED" && parse(bounded.body).max_tokens).toBe(100);
  });

  it("REFUSE un plafond de sortie inexploitable : on ne retombe pas sur un défaut", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(boundCompletionBody(JSON.stringify({}), bad).kind).toBe("UNBOUNDABLE");
    }
  });
});
