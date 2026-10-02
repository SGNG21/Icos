import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OmniRouteCeoClient } from "./omniroute-ceo-client";

/**
 * VERROU C1 — LE QUATRIÈME ET DERNIER CHEMIN NON MESURÉ.
 *
 * Quatre appelants émettent des complétions OmniRoute. Celui-ci acceptait déjà un `fetch`
 * injectable et personne ne le lui passait : ses appels partaient sur le `fetch` global,
 * donc hors du journal, sans réservation et sans borne de sortie. Un compteur que l'on
 * contourne en oubliant un argument n'est pas un compteur.
 */

const env = { ...process.env };

beforeEach(() => {
  process.env.OMNIROUTE_BASE_URL = "https://provider.test";
  process.env.OMNIROUTE_API_KEY = "cle";
  process.env.ICOS_CEO_MODEL = "modele-ceo";
});
afterEach(() => {
  process.env = { ...env };
});

describe("OmniRouteCeoClient — la couture du compteur", () => {
  it("ÉMET à travers le fetch fourni, jamais sur le fetch global", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const metered = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "bonjour" } }] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const answer = await new OmniRouteCeoClient(metered).answer([
      { role: "user", content: "salut" },
    ] as never);

    expect(answer).toContain("bonjour");
    expect(metered).toHaveBeenCalled();
    expect(String(metered.mock.calls[0]?.[0])).toContain("/v1/chat/completions");
    /* LA propriété : rien n'est passé à côté du compteur. */
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("refuse d'exister sans configuration : pas de dépense sur un fournisseur deviné", () => {
    delete process.env.OMNIROUTE_BASE_URL;
    expect(() => new OmniRouteCeoClient()).toThrow(/ICOS_AI_NOT_CONFIGURED/);
  });
});
