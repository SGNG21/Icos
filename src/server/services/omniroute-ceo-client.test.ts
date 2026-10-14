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

describe("OmniRouteCeoClient — explicit conversation models (migration 2026-10-14)", () => {
  const SUPER = "nvidia/nvidia/nemotron-3-super-120b-a12b";
  const ULTRA = "nvidia/nvidia/nemotron-3-ultra-550b-a55b";

  const ok = (content = "bonjour") =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      headers: { "content-type": "application/json" },
    });
  const status = (code: number) => new Response("{}", { status: code });
  const modelOf = (init: RequestInit | undefined) =>
    (JSON.parse(String(init?.body)) as { model: string }).model;

  /** Records every request; answers by model from `script`. */
  function gateway(script: Record<string, () => Response>) {
    const urls: string[] = [];
    const models: string[] = [];
    const impl = vi.fn<typeof fetch>(async (input, init) => {
      urls.push(String(input));
      const model = modelOf(init);
      models.push(model);
      return (script[model] ?? (() => status(404)))();
    });
    return { impl, urls, models };
  }

  beforeEach(() => {
    delete process.env.ICOS_CEO_MODEL;
    delete process.env.ICOS_REVIEWER_MODEL;
    delete process.env.ICOS_CONVERSATION_MODELS;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("BEFORE: auto/best-chat or the first listed id; AFTER: the measured free default, no discovery", async () => {
    const gw = gateway({ [SUPER]: () => ok() });
    await new OmniRouteCeoClient(gw.impl).answer([{ role: "user", content: "salut" }] as never);
    expect(gw.models).toEqual([SUPER]);
    /* No GET /v1/models: the gateway's listing never chooses the model. */
    expect(gw.urls.every((u) => u.endsWith("/v1/chat/completions"))).toBe(true);
  });

  it("falls back ONLY to the next listed model, on 429 / 5xx", async () => {
    process.env.ICOS_CONVERSATION_MODELS = `${ULTRA},${SUPER}`;
    const gw = gateway({ [ULTRA]: () => status(429), [SUPER]: () => ok("depuis super") });
    const answer = await new OmniRouteCeoClient(gw.impl).answer([
      { role: "user", content: "salut" },
    ] as never);
    expect(answer).toBe("depuis super");
    expect(gw.models).toEqual([ULTRA, SUPER]);
  });

  it("never falls back to auto/nvidia-chat or any unlisted model; exhaustion is named", async () => {
    process.env.ICOS_CONVERSATION_MODELS = `${ULTRA},${SUPER}`;
    const gw = gateway({ [ULTRA]: () => status(502), [SUPER]: () => status(503) });
    await expect(
      new OmniRouteCeoClient(gw.impl).answer([{ role: "user", content: "salut" }] as never),
    ).rejects.toThrow(/^CONVERSATION_MODELS_EXHAUSTED: .*HTTP 502 \| .*HTTP 503$/);
    expect(gw.models).toEqual([ULTRA, SUPER]);
  });

  it("a 4xx is not a reason to spend on another model", async () => {
    process.env.ICOS_CONVERSATION_MODELS = `${ULTRA},${SUPER}`;
    const gw = gateway({ [ULTRA]: () => status(401), [SUPER]: () => ok() });
    await expect(
      new OmniRouteCeoClient(gw.impl).answer([{ role: "user", content: "salut" }] as never),
    ).rejects.toThrow(/HTTP 401/);
    expect(gw.models).toEqual([ULTRA]);
  });

  it("COMPATIBILITY: an explicit ICOS_CEO_MODEL is honoured alone, without an added fallback", async () => {
    process.env.ICOS_CEO_MODEL = "cc/claude-sonnet-5";
    const gw = gateway({ "cc/claude-sonnet-5": () => status(503) });
    await expect(
      new OmniRouteCeoClient(gw.impl).answer([{ role: "user", content: "salut" }] as never),
    ).rejects.toThrow(/CONVERSATION_MODELS_EXHAUSTED: cc\/claude-sonnet-5 → HTTP 503$/);
    expect(gw.models).toEqual(["cc/claude-sonnet-5"]);
  });

  it.each([
    ["ICOS_CEO_MODEL", "auto/best-chat"],
    ["ICOS_REVIEWER_MODEL", "auto/nvidia-chat"],
    ["ICOS_CONVERSATION_MODELS", `${SUPER},openrouter/auto`],
  ])("a meta-route in %s refuses the client before any call", (variable, value) => {
    process.env[variable] = value;
    const gw = gateway({});
    expect(() => new OmniRouteCeoClient(gw.impl)).toThrow(
      new RegExp(`CONVERSATION_MODEL_NOT_ADMISSIBLE:${variable}`),
    );
    expect(gw.impl).not.toHaveBeenCalled();
  });
});
