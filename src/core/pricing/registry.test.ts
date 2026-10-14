import { describe, expect, it } from "vitest";

import { UNPRICED, type TokenUsage } from "@/core/budget/contracts";
import { ICOS_PRICE_TABLE, priceUsage } from "@/core/budget/price-table";
import { accumulate, decide, emptyWindow } from "@/core/budget/spend";

import {
  DEFAULT_FRESHNESS_DAYS,
  FREE_TIER_MAX_FRESHNESS_DAYS,
  ICOS_PRICE_REGISTRY,
  MICROS_PER_UNIT,
  UNKNOWN_PRICE,
  ambiguousModelIds,
  costMicros,
  microsToAmount,
  priceUsageMicros,
  recordDefect,
  resolvePrice,
  staleAfterFrom,
  type FreeTierPriceRecord,
  type PriceRecord,
  type RatePriceRecord,
} from "./registry";

/**
 * Tout tarif de ce fichier est FICTIF (`test/model`, fournisseur `test`). Aucun prix d'un
 * modèle réel n'est écrit ici ni dans le registre : un tarif inventé serait pire qu'absent,
 * parce que quelqu'un budgéterait de l'argent réel dessus.
 */

const NOW = new Date("2026-10-02T12:00:00.000Z");

const record = (overrides: Partial<RatePriceRecord> = {}): RatePriceRecord => ({
  provider: "test",
  modelId: "test/model",
  currency: "EUR",
  /* 3 EUR par million de tokens de prompt, exprimé en micros : 3 * 1e6. */
  promptMicrosPerMillion: 3 * MICROS_PER_UNIT,
  completionMicrosPerMillion: 15 * MICROS_PER_UNIT,
  provenance: "fixture de test",
  effectiveAt: "2026-09-01T00:00:00.000Z",
  staleAfter: "2026-12-01T00:00:00.000Z",
  ...overrides,
});

const usage = (prompt: number, completion: number, total?: number): TokenUsage => ({
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: total ?? prompt + completion,
});

describe("ICOS_PRICE_REGISTRY", () => {
  it("est VIDE : aucun prix de modèle réel n'est inscrit", () => {
    expect(ICOS_PRICE_REGISTRY).toEqual([]);
  });

  it("rend UNKNOWN_PRICE pour n'importe quel modèle réel tant qu'il est vide", () => {
    for (const modelId of ["auto/best-chat", "test/model", ""]) {
      const resolved = resolvePrice(ICOS_PRICE_REGISTRY, modelId, NOW);
      expect(resolved.kind).toBe(UNKNOWN_PRICE);
    }
  });

  it("UNKNOWN_PRICE et UNPRICED sont le MÊME sentinel : un seul mot circule", () => {
    // Deux chaînes différentes pour le même fait créeraient deux vocabulaires, donc deux
    // autorités, et un consommateur qui en ignore une lirait « chiffré ».
    expect(UNKNOWN_PRICE).toBe(UNPRICED);
  });
});

describe("recordDefect", () => {
  it("accepte une entrée complète", () => {
    expect(recordDefect(record())).toBeNull();
  });

  it.each([
    ["tarif de prompt nul", record({ promptMicrosPerMillion: 0 })],
    ["tarif de complétion nul", record({ completionMicrosPerMillion: 0 })],
    ["tarif négatif", record({ promptMicrosPerMillion: -1 })],
    ["tarif non entier", record({ promptMicrosPerMillion: 1.5 })],
    ["tarif non fini", record({ completionMicrosPerMillion: Number.NaN })],
    ["tarif infini", record({ promptMicrosPerMillion: Number.POSITIVE_INFINITY })],
    ["tarif absurde", record({ promptMicrosPerMillion: 1e18 })],
    ["devise non supportée", record({ currency: "USD" as never })],
    ["provenance vide", record({ provenance: "   " })],
    ["fournisseur vide", record({ provider: "" })],
    ["modèle vide", record({ modelId: "  " })],
    ["effectiveAt illisible", record({ effectiveAt: "bientôt" })],
    ["staleAfter illisible", record({ staleAfter: "" })],
    ["péremption avant entrée en vigueur", record({ staleAfter: "2026-08-01T00:00:00.000Z" })],
  ])("refuse : %s", (_label, bad) => {
    expect(recordDefect(bad)).not.toBeNull();
  });

  it("un tarif à 0 n'est pas un modèle gratuit mais une entrée inutilisable", () => {
    const free = [record({ promptMicrosPerMillion: 0, completionMicrosPerMillion: 0 })];
    const outcome = priceUsageMicros(free, "test/model", usage(1_000_000, 1_000_000), NOW);
    expect(outcome.kind).toBe(UNKNOWN_PRICE);
    if (outcome.kind !== UNKNOWN_PRICE) throw new Error("attendu UNKNOWN_PRICE");
    expect(outcome.defect).toBe("INVALID_ENTRY");
  });
});

describe("resolvePrice", () => {
  it("rend le tarif quand il est valide et frais", () => {
    const resolved = resolvePrice([record()], "test/model", NOW);
    expect(resolved.kind).toBe("PRICE");
  });

  it("ABSENT : un modèle inconnu n'emprunte pas le tarif d'un voisin", () => {
    // Interpoler depuis un modèle frère serait une fabrication.
    const resolved = resolvePrice([record()], "test/model-pro", NOW);
    if (resolved.kind !== UNKNOWN_PRICE) throw new Error("attendu UNKNOWN_PRICE");
    expect(resolved.defect).toBe("ABSENT");
  });

  it("AMBIGUOUS : deux tarifs concurrents pour un modèle n'en désignent aucun", () => {
    const registry = [record(), record({ promptMicrosPerMillion: 9 * MICROS_PER_UNIT })];
    const resolved = resolvePrice(registry, "test/model", NOW);
    if (resolved.kind !== UNKNOWN_PRICE) throw new Error("attendu UNKNOWN_PRICE");
    expect(resolved.defect).toBe("AMBIGUOUS");
  });

  it("NOT_YET_EFFECTIVE : un tarif daté du futur n'est pas appliqué aujourd'hui", () => {
    const resolved = resolvePrice(
      [record({ effectiveAt: "2026-11-01T00:00:00.000Z" })],
      "test/model",
      NOW,
    );
    if (resolved.kind !== UNKNOWN_PRICE) throw new Error("attendu UNKNOWN_PRICE");
    expect(resolved.defect).toBe("NOT_YET_EFFECTIVE");
  });

  it("STALE : un tarif au-delà de son horizon de fraîcheur devient inutilisable", () => {
    // Le montant serait « presque juste » — c'est exactement ce qu'il ne faut pas rendre.
    const resolved = resolvePrice([record()], "test/model", new Date("2026-12-01T00:00:00.000Z"));
    if (resolved.kind !== UNKNOWN_PRICE) throw new Error("attendu UNKNOWN_PRICE");
    expect(resolved.defect).toBe("STALE");
  });

  it("reste utilisable à la dernière milliseconde avant péremption", () => {
    const resolved = resolvePrice([record()], "test/model", new Date("2026-11-30T23:59:59.999Z"));
    expect(resolved.kind).toBe("PRICE");
  });

  it("UNUSABLE_CLOCK : une horloge illisible ne vaut pas « frais »", () => {
    // `NaN >= staleAfter` est faux : sans ce garde-fou une date invalide ferait passer
    // n'importe quel tarif périmé pour utilisable.
    const resolved = resolvePrice([record()], "test/model", new Date("pas une date"));
    if (resolved.kind !== UNKNOWN_PRICE) throw new Error("attendu UNKNOWN_PRICE");
    expect(resolved.defect).toBe("UNUSABLE_CLOCK");
  });
});

describe("ambiguousModelIds", () => {
  it("ne signale que les modèles portés par plusieurs entrées", () => {
    const registry = [record(), record(), record({ modelId: "test/other" })];
    expect([...ambiguousModelIds(registry)]).toEqual(["test/model"]);
  });
});

describe("costMicros", () => {
  it("chiffre en micros ENTIERS, jamais en flottant", () => {
    const outcome = costMicros(record(), usage(1_000_000, 500_000));
    if (outcome.kind !== "COST_MICROS") throw new Error("attendu COST_MICROS");
    // 3 EUR + 7,50 EUR = 10,50 EUR = 10 500 000 micros.
    expect(outcome.micros).toBe(10_500_000);
    expect(Number.isInteger(outcome.micros)).toBe(true);
  });

  it("chiffre une consommation nulle à 0 micro : une mesure, pas une absence", () => {
    expect(costMicros(record(), usage(0, 0))).toMatchObject({ kind: "COST_MICROS", micros: 0 });
  });

  it("ne perd jamais un centième de micro : arrondi au micro SUPÉRIEUR", () => {
    // 1 token à 3 EUR/Mtok = 3 micros exactement ; 1 token à 1 micro/Mtok vaut moins d'un
    // micro et doit coûter 1 micro, pas 0 : sous un plafond, surestimer est le sens sûr.
    expect(costMicros(record(), usage(1, 0))).toMatchObject({ micros: 3 });
    expect(costMicros(record({ promptMicrosPerMillion: 1 }), usage(1, 0))).toMatchObject({
      micros: 1,
    });
  });

  it("UNPRICED_TOKENS : refuse de chiffrer quand le fournisseur facture plus que prompt+completion", () => {
    // Tokens de raisonnement / de cache : aucun tarif ici, et on ne leur en invente pas,
    // pas même 0 — cela sous-évaluerait le total d'un ordre de grandeur.
    const outcome = costMicros(record(), usage(1_000, 1_000, 60_000));
    if (outcome.kind === "COST_MICROS") throw new Error("attendu UNKNOWN_PRICE");
    expect(outcome.defect).toBe("UNPRICED_TOKENS");
  });

  it("NOT_REPRESENTABLE : un coût hors de l'entier sûr est refusé, pas arrondi", () => {
    const outcome = costMicros(record({ promptMicrosPerMillion: 1e11 }), usage(1e9, 0));
    if (outcome.kind === "COST_MICROS") throw new Error("attendu UNKNOWN_PRICE");
    expect(outcome.defect).toBe("NOT_REPRESENTABLE");
  });

  it.each([
    ["tokens négatifs", usage(-1, 0)],
    ["tokens non entiers", usage(1.5, 0)],
    ["tokens non finis", usage(Number.NaN, 0)],
  ])("refuse une consommation inexploitable : %s", (_label, bad) => {
    expect(costMicros(record(), bad).kind).toBe(UNKNOWN_PRICE);
  });
});

describe("staleAfterFrom", () => {
  it("déduit la péremption de l'horizon de fraîcheur par défaut", () => {
    const from = "2026-09-01T00:00:00.000Z";
    const until = staleAfterFrom(from);
    expect(Date.parse(until) - Date.parse(from)).toBe(DEFAULT_FRESHNESS_DAYS * 86_400_000);
  });

  it("refuse une date d'entrée en vigueur illisible plutôt que d'en inventer une", () => {
    expect(() => staleAfterFrom("bientôt")).toThrow();
  });
});

describe("microsToAmount", () => {
  it("ne divise qu'au tout dernier moment, vers la frontière héritée", () => {
    expect(microsToAmount(10_500_000)).toBe(10.5);
    expect(microsToAmount(0)).toBe(0);
  });
});

describe("fermeture par défaut sur le budget (registre vide)", () => {
  const window = (modelId: string, prompt: number, completion: number) =>
    accumulate(emptyWindow(), {
      modelId,
      usage: { kind: "METERED", usage: usage(prompt, completion) },
      cost: priceUsage(ICOS_PRICE_TABLE, modelId, usage(prompt, completion)),
    });

  it("un plafond en EUR sur un modèle sans prix digne de confiance REFUSE l'appel", () => {
    const decision = decide(window("auto/best-chat", 1_000, 1_000), {
      kind: "CAPPED",
      maxAmount: 10,
    });
    expect(decision).toMatchObject({ kind: "DENY", reason: "UNPRICED_USAGE_IN_WINDOW" });
  });

  it("un plafond en tokens reste pleinement applicable avec un registre vide", () => {
    expect(
      decide(window("auto/best-chat", 100, 100), { kind: "CAPPED", maxTotalTokens: 1_000 }),
    ).toEqual({ kind: "ALLOW" });
    expect(
      decide(window("auto/best-chat", 600, 600), { kind: "CAPPED", maxTotalTokens: 1_000 }),
    ).toMatchObject({ kind: "DENY", reason: "TOKEN_CAP_REACHED" });
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("FREE_TIER — une gratuité vérifiée et datée, jamais un zéro par défaut (décision 0078)", () => {
  /* FICTIF : `example.invalid` n'est pas une page de conditions, `test/free` n'est pas un modèle. */
  const freeRecord = (overrides: Partial<FreeTierPriceRecord> = {}): FreeTierPriceRecord => ({
    kind: "FREE_TIER",
    provider: "test",
    modelId: "test/free",
    currency: "EUR",
    provenance: { source: "https://example.invalid/terms", verifiedOn: "2026-10-01" },
    conditions: "fixture : évaluation seulement, pas de production",
    verifiedQuota: "fixture : 20 requêtes/minute, 50/jour",
    effectiveAt: "2026-10-01T00:00:00.000Z",
    staleAfter: staleAfterFrom("2026-10-01T00:00:00.000Z", FREE_TIER_MAX_FRESHNESS_DAYS),
    ...overrides,
  });

  it("le registre livré ne contient AUCUNE gratuité : en inscrire une est un acte du propriétaire", () => {
    expect(ICOS_PRICE_REGISTRY.filter((r) => r.kind === "FREE_TIER")).toEqual([]);
  });

  it("une gratuité valide se résout FREE_TIER, jamais PRICE", () => {
    expect(recordDefect(freeRecord())).toBeNull();
    const resolved = resolvePrice([freeRecord()], "test/free", NOW);
    expect(resolved.kind).toBe("FREE_TIER");
  });

  it("se chiffre FREE_TIER à 0 micro avec sa provenance datée — pas COST_MICROS 0", () => {
    const outcome = priceUsageMicros([freeRecord()], "test/free", usage(1_000, 500), NOW);
    expect(outcome).toEqual({
      kind: "FREE_TIER",
      modelId: "test/free",
      currency: "EUR",
      micros: 0,
      provenance: { source: "https://example.invalid/terms", verifiedOn: "2026-10-01" },
    });
  });

  it("passé staleAfter, elle redevient UNPRICED/STALE — jamais COST, jamais encore gratuite", () => {
    const after = new Date("2026-10-31T00:00:00.000Z");
    const outcome = priceUsageMicros([freeRecord()], "test/free", usage(10, 10), after);
    expect(outcome.kind).toBe(UNKNOWN_PRICE);
    if (outcome.kind !== UNKNOWN_PRICE) throw new Error("attendu UNKNOWN_PRICE");
    expect(outcome.defect).toBe("STALE");
  });

  it("avant effectiveAt elle est NOT_YET_EFFECTIVE, horloge illisible UNUSABLE_CLOCK", () => {
    const early = resolvePrice(
      [freeRecord({ effectiveAt: "2026-10-05T00:00:00.000Z" })],
      "test/free",
      NOW,
    );
    expect(early).toMatchObject({ kind: UNKNOWN_PRICE, defect: "NOT_YET_EFFECTIVE" });
    expect(resolvePrice([freeRecord()], "test/free", new Date(Number.NaN))).toMatchObject({
      kind: UNKNOWN_PRICE,
      defect: "UNUSABLE_CLOCK",
    });
  });

  it(`refuse un horizon de plus de ${FREE_TIER_MAX_FRESHNESS_DAYS} jours après la vérification`, () => {
    const tooLong = freeRecord({
      staleAfter: staleAfterFrom("2026-10-01T00:00:00.000Z", FREE_TIER_MAX_FRESHNESS_DAYS + 1),
    });
    expect(recordDefect(tooLong)).toMatch(/horizon de gratuité trop long/);
    expect(resolvePrice([tooLong], "test/free", NOW)).toMatchObject({ defect: "INVALID_ENTRY" });
  });

  it("l'horizon se compte depuis la VÉRIFICATION, pas depuis une entrée en vigueur tardive", () => {
    const shifted = freeRecord({
      effectiveAt: "2026-10-10T00:00:00.000Z",
      staleAfter: "2026-11-05T00:00:00.000Z",
    });
    expect(recordDefect(shifted)).toMatch(/horizon de gratuité trop long/);
  });

  it("refuse une entrée en vigueur antérieure à la vérification", () => {
    expect(
      recordDefect(
        freeRecord({
          effectiveAt: "2026-09-30T00:00:00.000Z",
          staleAfter: "2026-10-20T00:00:00.000Z",
        }),
      ),
    ).toMatch(/antérieur à la vérification/);
  });

  it.each([
    ["source vide", { provenance: { source: "  ", verifiedOn: "2026-10-01" } }],
    ["date de vérification vide", { provenance: { source: "https://x.invalid", verifiedOn: "" } }],
    [
      "date de vérification non ISO",
      { provenance: { source: "https://x.invalid", verifiedOn: "1er octobre" } },
    ],
    ["conditions vides", { conditions: " " }],
    ["quota vide", { verifiedQuota: "" }],
    ["provider vide", { provider: "" }],
    ["devise non supportée", { currency: "USD" as "EUR" }],
  ] as const)("refuse : %s (INVALID_ENTRY)", (_label, overrides) => {
    const bad = freeRecord(overrides as Partial<FreeTierPriceRecord>);
    expect(recordDefect(bad)).not.toBeNull();
    expect(resolvePrice([bad], "test/free", NOW)).toMatchObject({
      kind: UNKNOWN_PRICE,
      defect: "INVALID_ENTRY",
    });
  });

  it("une gratuité ne porte AUCUN tarif — pas même un zéro (type ET exécution)", () => {
    // @ts-expect-error -- un FREE_TIER n'a pas de champ de tarif : il n'y a nulle part où taper 0.
    const typed: FreeTierPriceRecord = { ...freeRecord(), promptMicrosPerMillion: 0 };
    expect(recordDefect(typed)).toBe("une gratuité ne porte aucun tarif");
  });

  it("un kind inconnu n'est pas un tarif par défaut", () => {
    const odd = { ...record(), kind: "FREE" } as unknown as PriceRecord;
    expect(recordDefect(odd)).toMatch(/kind FREE inconnu/);
  });

  it("un tarif à zéro reste INVALID_ENTRY : la gratuité ne passe que par FREE_TIER", () => {
    const zero = record({ promptMicrosPerMillion: 0, completionMicrosPerMillion: 0 });
    expect(resolvePrice([zero], "test/model", NOW)).toMatchObject({ defect: "INVALID_ENTRY" });
  });

  it("un tarif ET une gratuité pour le même modèle sont AMBIGUOUS : aucun n'est choisi", () => {
    const both: PriceRecord[] = [record({ modelId: "test/free" }), freeRecord()];
    expect(resolvePrice(both, "test/free", NOW)).toMatchObject({
      kind: UNKNOWN_PRICE,
      defect: "AMBIGUOUS",
    });
  });

  it("modèle inconnu, coût inconnu et coût nul sont trois issues distinctes", () => {
    const registry: PriceRecord[] = [
      freeRecord(),
      record({ modelId: "test/stale", staleAfter: "2026-09-15T00:00:00.000Z" }),
    ];
    const unknownModel = priceUsageMicros(registry, "test/absent", usage(1, 1), NOW);
    const unknownCost = priceUsageMicros(registry, "test/stale", usage(1, 1), NOW);
    const nil = priceUsageMicros(registry, "test/free", usage(1, 1), NOW);
    expect(unknownModel).toMatchObject({ kind: UNKNOWN_PRICE, defect: "ABSENT" });
    expect(unknownCost).toMatchObject({ kind: UNKNOWN_PRICE, defect: "STALE" });
    expect(nil).toMatchObject({ kind: "FREE_TIER", micros: 0 });
  });

  it("UNPRICED_TOKENS ne s'applique pas : la gratuité couvre l'appel, pas des classes de tokens", () => {
    expect(priceUsageMicros([freeRecord()], "test/free", usage(10, 10, 50), NOW)).toMatchObject({
      kind: "FREE_TIER",
    });
  });

  it("un décompte illisible reste NOT_REPRESENTABLE, même gratuit", () => {
    expect(priceUsageMicros([freeRecord()], "test/free", usage(-1, 0), NOW)).toMatchObject({
      kind: UNKNOWN_PRICE,
      defect: "NOT_REPRESENTABLE",
    });
  });

  describe("costMicros ne produit JAMAIS FREE_TIER : seule une résolution le peut", () => {
    const asRate = (r: FreeTierPriceRecord) => r as unknown as RatePriceRecord;

    it.each([
      ["valide", freeRecord()],
      ["aux conditions vides", freeRecord({ conditions: "" })],
      [
        "périmée",
        freeRecord({
          provenance: { source: "https://example.invalid/terms", verifiedOn: "2026-01-01" },
          effectiveAt: "2026-01-01T00:00:00.000Z",
          staleAfter: "2026-01-15T00:00:00.000Z",
        }),
      ],
    ])("une gratuité %s passée par cast est INVALID_ENTRY, pas 0", (_label, free) => {
      expect(costMicros(asRate(free), usage(10, 10))).toMatchObject({
        kind: UNKNOWN_PRICE,
        defect: "INVALID_ENTRY",
      });
    });

    it("le même enregistrement, résolu et valide, est FREE_TIER par priceUsageMicros", () => {
      expect(priceUsageMicros([freeRecord()], "test/free", usage(10, 10), NOW).kind).toBe(
        "FREE_TIER",
      );
    });
  });

  describe("une date de preuve doit être un VRAI jour calendaire (Date.parse normalise 02-30)", () => {
    it.each([
      ["2026-02-30", "2026-02-30T00:00:00.000Z", "2026-03-15T00:00:00.000Z"],
      ["2026-04-31", "2026-05-01T00:00:00.000Z", "2026-05-15T00:00:00.000Z"],
    ])("verifiedOn %s est INVALID_ENTRY", (verifiedOn, effectiveAt, staleAfter) => {
      const bad = freeRecord({
        provenance: { source: "https://example.invalid/terms", verifiedOn },
        effectiveAt,
        staleAfter,
      });
      expect(recordDefect(bad)).toMatch(/hors calendrier/);
      expect(resolvePrice([bad], "test/free", new Date("2026-03-05T00:00:00.000Z"))).toMatchObject({
        kind: UNKNOWN_PRICE,
        defect: "INVALID_ENTRY",
      });
    });

    it("effectiveAt ou staleAfter hors calendrier est INVALID_ENTRY, gratuité comme tarif", () => {
      expect(
        recordDefect(
          freeRecord({
            provenance: { source: "https://example.invalid/terms", verifiedOn: "2026-02-27" },
            effectiveAt: "2026-02-30T00:00:00.000Z",
            staleAfter: "2026-03-20T00:00:00.000Z",
          }),
        ),
      ).toMatch(/effectiveAt hors calendrier/);
      expect(recordDefect(record({ staleAfter: "2026-11-31T00:00:00.000Z" }))).toMatch(
        /staleAfter hors calendrier/,
      );
    });

    it("un vrai 29 février (année bissextile) reste accepté", () => {
      expect(
        recordDefect(
          freeRecord({
            provenance: { source: "https://example.invalid/terms", verifiedOn: "2028-02-29" },
            effectiveAt: "2028-02-29T00:00:00.000Z",
            staleAfter: "2028-03-20T00:00:00.000Z",
          }),
        ),
      ).toBeNull();
    });
  });
});
