import { describe, expect, it, vi } from "vitest";

import type { Attribution, SpendDecision } from "@/core/budget/contracts";
import { MICROS_PER_EUR } from "@/core/budget/contracts";
import type { PriceTable } from "@/core/budget/price-table";
import type { SpendWindow } from "@/core/budget/spend";
import { emptyWindow } from "@/core/budget/spend";

import { InMemorySpendLedger } from "./in-memory-spend-ledger";
import { BudgetDeniedError, BudgetLedgerError, meteredFetch } from "./metered-fetch";
import type { SpendEntry, SpendLedgerPort } from "./ports";

const COMPLETION_BODY = {
  id: "chatcmpl-1",
  model: "test/model",
  choices: [{ message: { content: "bonjour" } }],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
};

const PRICE_TABLE: PriceTable = {
  "test/model": {
    modelId: "test/model",
    currency: "EUR",
    promptPerMillion: 2,
    completionPerMillion: 4,
    provenance: "fixture de test",
    asOf: "2026-10-02",
  },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Journal de test : enregistre tout, décide ce qu'on lui dit de décider. */
class FakeLedger implements SpendLedgerPort {
  readonly recorded: SpendEntry[] = [];
  readonly checks: (Attribution | null)[] = [];
  constructor(
    private readonly decision: SpendDecision = { kind: "ALLOW" },
    private readonly onRecord?: () => void,
  ) {}
  async checkBudget(attribution: Attribution | null): Promise<SpendDecision> {
    this.checks.push(attribution);
    return this.decision;
  }
  async record(entry: SpendEntry): Promise<void> {
    this.onRecord?.();
    this.recorded.push(entry);
  }
  async windowFor(): Promise<SpendWindow> {
    return emptyWindow();
  }
}

const URL_UNDER_TEST = "https://omniroute.invalid/v1/chat/completions";
const chatInit = (model = "test/model"): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ model, messages: [] }),
  headers: { "content-type": "application/json" },
});

describe("meteredFetch — contrôle pré-vol", () => {
  it("REFUSE SANS APPELER inner", async () => {
    const inner = vi.fn<typeof fetch>();
    const ledger = new FakeLedger({
      kind: "DENY",
      reason: "MONEY_CAP_REACHED",
      detail: "10 EUR atteints",
    });

    await expect(meteredFetch(inner, { ledger })(URL_UNDER_TEST, chatInit())).rejects.toThrow(
      BudgetDeniedError,
    );
    expect(inner).not.toHaveBeenCalled();
    expect(ledger.recorded).toHaveLength(0);
  });

  it("porte le motif typé et le détail dans l'erreur de refus", async () => {
    const ledger = new FakeLedger({
      kind: "DENY",
      reason: "UNPRICED_USAGE_IN_WINDOW",
      detail: "3 appels sans prix",
    });
    const call = meteredFetch(vi.fn<typeof fetch>(), { ledger })(URL_UNDER_TEST, chatInit());
    await expect(call).rejects.toMatchObject({
      name: "BudgetDeniedError",
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
    await call.catch((error: unknown) => {
      expect(String(error)).toContain("3 appels sans prix");
    });
  });

  it("consulte le journal avec l'attribution fournie", async () => {
    const ledger = new FakeLedger();
    const attribution = { goalId: "g1", missionId: "m1" };
    await meteredFetch(async () => jsonResponse(COMPLETION_BODY), { ledger, attribution })(
      URL_UNDER_TEST,
      chatInit(),
    );
    expect(ledger.checks).toEqual([attribution]);
  });
});

describe("meteredFetch — invariant du corps cloné", () => {
  it("rend une réponse ENCORE entièrement lisible par l'appelant", async () => {
    const ledger = new FakeLedger();
    const response = await meteredFetch(async () => jsonResponse(COMPLETION_BODY), { ledger })(
      URL_UNDER_TEST,
      chatInit(),
    );

    expect(response.bodyUsed).toBe(false);
    await expect(response.json()).resolves.toEqual(COMPLETION_BODY);
    // Et la mesure a bien eu lieu malgré tout.
    expect(ledger.recorded[0]?.usage).toEqual({
      kind: "METERED",
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    });
  });

  it("laisse l'appelant lire le corps en texte brut sans perte", async () => {
    const ledger = new FakeLedger();
    const raw = JSON.stringify(COMPLETION_BODY);
    const response = await meteredFetch(
      async () => new Response(raw, { headers: { "content-type": "application/json" } }),
      { ledger },
    )(URL_UNDER_TEST, chatInit());
    await expect(response.text()).resolves.toBe(raw);
  });

  it("rend exactement l'objet Response de inner, statut et en-têtes compris", async () => {
    const ledger = new FakeLedger();
    const original = new Response(JSON.stringify(COMPLETION_BODY), {
      status: 201,
      headers: { "content-type": "application/json", "x-trace": "abc" },
    });
    const response = await meteredFetch(async () => original, { ledger })(
      URL_UNDER_TEST,
      chatInit(),
    );
    expect(response).toBe(original);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-trace")).toBe("abc");
  });
});

describe("meteredFetch — vérité de la mesure", () => {
  it("impute au modèle rapporté par la réponse, pas à celui demandé", async () => {
    const ledger = new FakeLedger();
    await meteredFetch(async () => jsonResponse({ ...COMPLETION_BODY, model: "route/reel" }), {
      ledger,
    })(URL_UNDER_TEST, chatInit("auto/best-chat"));
    expect(ledger.recorded[0]?.modelId).toBe("route/reel");
  });

  it("retombe sur le modèle demandé quand la réponse ne le dit pas", async () => {
    const ledger = new FakeLedger();
    const { usage, choices } = COMPLETION_BODY;
    await meteredFetch(async () => jsonResponse({ usage, choices }), { ledger })(
      URL_UNDER_TEST,
      chatInit("demande/modele"),
    );
    expect(ledger.recorded[0]?.modelId).toBe("demande/modele");
  });

  it("enregistre UNMETERED pour un flux SSE, jamais 0", async () => {
    const ledger = new FakeLedger();
    const stream = new Response("data: {}\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const response = await meteredFetch(async () => stream, { ledger })(URL_UNDER_TEST, chatInit());
    expect(ledger.recorded[0]?.usage).toEqual({ kind: "UNMETERED", reason: "NON_JSON_BODY" });
    // Le flux de l'appelant n'a pas été touché.
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toContain("[DONE]");
  });

  it("enregistre UNMETERED quand le JSON n'a pas de bloc usage", async () => {
    const ledger = new FakeLedger();
    await meteredFetch(async () => jsonResponse({ model: "test/model", choices: [] }), { ledger })(
      URL_UNDER_TEST,
      chatInit(),
    );
    expect(ledger.recorded[0]?.usage).toMatchObject({ kind: "UNMETERED", reason: "USAGE_ABSENT" });
  });

  it("enregistre UNMETERED quand le corps annoncé JSON est illisible", async () => {
    const ledger = new FakeLedger();
    await meteredFetch(
      async () => new Response("{pas du json", { headers: { "content-type": "application/json" } }),
      { ledger },
    )(URL_UNDER_TEST, chatInit());
    expect(ledger.recorded[0]?.usage).toMatchObject({
      kind: "UNMETERED",
      reason: "NON_JSON_BODY",
    });
  });

  it("enregistre un appel sans attribution comme non attribué", async () => {
    const ledger = new FakeLedger();
    await meteredFetch(async () => jsonResponse(COMPLETION_BODY), { ledger })(
      URL_UNDER_TEST,
      chatInit(),
    );
    expect(ledger.recorded).toHaveLength(1);
    expect(ledger.recorded[0]?.attribution).toBeNull();
  });

  it("horodate l'observation avec l'horloge injectée", async () => {
    const ledger = new FakeLedger();
    await meteredFetch(async () => jsonResponse(COMPLETION_BODY), {
      ledger,
      now: () => new Date("2026-10-02T12:00:00.000Z"),
    })(URL_UNDER_TEST, chatInit());
    expect(ledger.recorded[0]?.at).toBe("2026-10-02T12:00:00.000Z");
  });
});

describe("meteredFetch — ne mesure que les complétions", () => {
  const MODELS_URL = "https://omniroute.invalid/v1/models";
  const MODELS_BODY = { object: "list", data: [{ id: "auto/best-chat" }] };

  it("N'ENREGISTRE RIEN pour une requête qui n'est pas une complétion", async () => {
    // `OmniRouteCeoClient.resolveModel` fait GET /v1/models par le MÊME fetch injecté.
    // Cette réponse est un 2xx JSON sans `usage` : l'enregistrer UNMETERED condamnait
    // l'imputation entière dès la découverte des modèles, sans décroissance ni remise à zéro.
    const ledger = new FakeLedger();
    const response = await meteredFetch(async () => jsonResponse(MODELS_BODY), { ledger })(
      MODELS_URL,
      { headers: { Authorization: "Bearer x" } },
    );
    expect(ledger.recorded).toHaveLength(0);
    await expect(response.json()).resolves.toEqual(MODELS_BODY);
  });

  it("reconnaît la complétion quelle que soit la forme de `input`", async () => {
    for (const input of [
      URL_UNDER_TEST,
      new URL(URL_UNDER_TEST),
      new Request(URL_UNDER_TEST, { method: "POST" }),
    ]) {
      const ledger = new FakeLedger();
      await meteredFetch(async () => jsonResponse(COMPLETION_BODY), { ledger })(input, chatInit());
      expect(ledger.recorded).toHaveLength(1);
    }
  });

  it("enregistre QUAND MÊME UNMETERED pour une complétion en flux", async () => {
    // Garde-fou contre la sur-correction : une complétion dont la consommation est illisible
    // est une vraie dépense qu'ICOS n'a pas pu mesurer. La laisser passer silencieusement
    // rouvrirait le trou que ce module ferme.
    const ledger = new FakeLedger();
    await meteredFetch(
      async () =>
        new Response("data: {}\n\ndata: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      { ledger },
    )(URL_UNDER_TEST, chatInit());
    expect(ledger.recorded[0]?.usage).toEqual({ kind: "UNMETERED", reason: "NON_JSON_BODY" });
  });
});

describe("meteredFetch — ne corrompt pas le journal", () => {
  it("n'enregistre rien sur une réponse non 2xx et la rend inchangée", async () => {
    const ledger = new FakeLedger();
    const failure = jsonResponse({ error: "rate limited" }, 429);
    const response = await meteredFetch(async () => failure, { ledger })(
      URL_UNDER_TEST,
      chatInit(),
    );
    expect(response).toBe(failure);
    expect(response.status).toBe(429);
    expect(ledger.recorded).toHaveLength(0);
    await expect(response.json()).resolves.toEqual({ error: "rate limited" });
  });

  it("laisse passer l'erreur réseau de l'appelant telle quelle, sans rien enregistrer", async () => {
    const ledger = new FakeLedger();
    const boom = new TypeError("fetch failed");
    await expect(
      meteredFetch(
        async () => {
          throw boom;
        },
        { ledger },
      )(URL_UNDER_TEST, chatInit()),
    ).rejects.toBe(boom);
    expect(ledger.recorded).toHaveLength(0);
  });

  it("laisse passer une annulation sans rien enregistrer", async () => {
    const ledger = new FakeLedger();
    const controller = new AbortController();
    controller.abort(new Error("ABORTED_BY_TEST"));
    await expect(
      meteredFetch(
        async (_input, init) => {
          init?.signal?.throwIfAborted();
          return jsonResponse(COMPLETION_BODY);
        },
        { ledger },
      )(URL_UNDER_TEST, { ...chatInit(), signal: controller.signal }),
    ).rejects.toThrow("ABORTED_BY_TEST");
    expect(ledger.recorded).toHaveLength(0);
  });

  it("signale une panne du journal au lieu de laisser une dépense non comptée", async () => {
    const ledger = new FakeLedger({ kind: "ALLOW" }, () => {
      throw new Error("journal indisponible");
    });
    await expect(
      meteredFetch(async () => jsonResponse(COMPLETION_BODY), { ledger })(
        URL_UNDER_TEST,
        chatInit(),
      ),
    ).rejects.toThrow(BudgetLedgerError);
  });
});

describe("meteredFetch — bout en bout avec le journal en mémoire", () => {
  it("applique « budget maximum 10 EUR » : laisse passer puis refuse", async () => {
    const ledger = new InMemorySpendLedger({
      caps: async () => ({ kind: "CAPPED", maxCostMicros: 10 * MICROS_PER_EUR }),
      priceTable: PRICE_TABLE,
    });
    const inner = vi.fn<typeof fetch>(async () =>
      // 2 000 000 prompt * 2/1e6 = 4 EUR par appel.
      jsonResponse({
        model: "test/model",
        usage: { prompt_tokens: 2_000_000, completion_tokens: 0, total_tokens: 2_000_000 },
      }),
    );
    const fetchWithMeter = meteredFetch(inner, { ledger, attribution: { goalId: "g1" } });

    await fetchWithMeter(URL_UNDER_TEST, chatInit());
    await fetchWithMeter(URL_UNDER_TEST, chatInit());
    expect(inner).toHaveBeenCalledTimes(2);
    expect((await ledger.windowFor({ goalId: "g1" })).amount).toBeCloseTo(8, 10);

    await fetchWithMeter(URL_UNDER_TEST, chatInit());
    expect(inner).toHaveBeenCalledTimes(3);
    expect((await ledger.windowFor({ goalId: "g1" })).amount).toBeCloseTo(12, 10);

    // Le plafond est désormais dépassé : le quatrième appel est refusé avant d'être émis.
    await expect(fetchWithMeter(URL_UNDER_TEST, chatInit())).rejects.toThrow(BudgetDeniedError);
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("UNPRICED ne peut pas être blanchi en plafond monétaire satisfait", async () => {
    const ledger = new InMemorySpendLedger({
      caps: async () => ({ kind: "CAPPED", maxCostMicros: 10 * MICROS_PER_EUR }),
      priceTable: {}, // table vide : état honnête par défaut
    });
    const inner = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        model: "sans/prix",
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
    const fetchWithMeter = meteredFetch(inner, { ledger, attribution: { goalId: "g1" } });

    await fetchWithMeter(URL_UNDER_TEST, chatInit());
    const window = await ledger.windowFor({ goalId: "g1" });
    expect(window.amount).toBe(0);
    expect(window.unpricedCalls).toBe(1);

    await expect(fetchWithMeter(URL_UNDER_TEST, chatInit())).rejects.toMatchObject({
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("applique un plafond de tokens sans aucune table de prix", async () => {
    const ledger = new InMemorySpendLedger({
      caps: async () => ({ kind: "CAPPED", maxTotalTokens: 1_000 }),
      priceTable: {},
    });
    const inner = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        model: "sans/prix",
        usage: { prompt_tokens: 600, completion_tokens: 600, total_tokens: 1_200 },
      }),
    );
    const fetchWithMeter = meteredFetch(inner, { ledger, attribution: { goalId: "g1" } });
    await fetchWithMeter(URL_UNDER_TEST, chatInit());
    await expect(fetchWithMeter(URL_UNDER_TEST, chatInit())).rejects.toMatchObject({
      reason: "TOKEN_CAP_REACHED",
    });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("un appel non mesuré bloque la suite plutôt que de passer pour gratuit", async () => {
    const ledger = new InMemorySpendLedger({
      caps: async () => ({ kind: "CAPPED", maxTotalTokens: 1_000_000 }),
      priceTable: PRICE_TABLE,
    });
    const fetchWithMeter = meteredFetch(
      async () => new Response("data: ...", { headers: { "content-type": "text/event-stream" } }),
      { ledger, attribution: { goalId: "g1" } },
    );
    await fetchWithMeter(URL_UNDER_TEST, chatInit());
    await expect(fetchWithMeter(URL_UNDER_TEST, chatInit())).rejects.toMatchObject({
      reason: "UNMETERED_USAGE_IN_WINDOW",
    });
  });

  it("est bien du type `typeof fetch` et se substitue au fetch injecté des cinq appelants", () => {
    const ledger = new FakeLedger();
    const substitute: typeof fetch = meteredFetch(globalThis.fetch, { ledger });
    expect(typeof substitute).toBe("function");
  });
});
