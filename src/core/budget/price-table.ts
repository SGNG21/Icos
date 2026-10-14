import {
  ICOS_PRICE_REGISTRY,
  MICROS_PER_UNIT,
  ambiguousModelIds,
  microsToAmount,
  recordDefect,
  priceUsageMicros,
  type FreeTierPriceRecord,
  type PriceRecord,
  type PriceRegistry,
} from "@/core/pricing/registry";

import {
  BUDGET_CURRENCY,
  FREE_TIER,
  UNPRICED,
  type BudgetCurrency,
  type CostOutcome,
  type FreeTierProvenance,
  type TokenUsage,
} from "./contracts";

/**
 * Vue « table » du registre de prix, par identifiant de modèle.
 *
 * Ce fichier n'est plus une autorité de tarif : l'autorité unique est
 * `src/core/pricing/registry.ts` (validation, fraîcheur, arithmétique en micros entiers).
 * Il reste ici la FORME héritée attendue par la couche dépense (`PriceEntry`, `priceUsage`)
 * et la projection du registre vers cette forme.
 *
 * Un modèle absent rend UNPRICED. Il n'y a pas de prix par défaut et pas de 0 : un appel
 * UNPRICED consomme quand même le budget en tokens et doit être rapporté.
 */

export interface RatePriceEntry {
  readonly kind?: "RATE";
  /** Doit être égal à la clé qui porte l'entrée (garde contre les copier-coller). */
  readonly modelId: string;
  readonly currency: BudgetCurrency;
  /** Prix pour 1 000 000 de tokens de prompt. */
  readonly promptPerMillion: number;
  /** Prix pour 1 000 000 de tokens de complétion. */
  readonly completionPerMillion: number;
  /** D'où vient ce prix : facture, page de tarif, contrat. Jamais « de mémoire ». */
  readonly provenance: string;
  /** Date de constat du prix, ISO `YYYY-MM-DD`. */
  readonly asOf: string;
  /** Renseignés par {@link priceTableFrom}. Facultatifs sur une entrée injectée à la main. */
  readonly provider?: string;
  readonly effectiveAt?: string;
  readonly staleAfter?: string;
}

/**
 * Une gratuité dans la forme « table ». Contrairement à un tarif injecté à la main, elle n'a
 * AUCUNE fraîcheur par défaut : `effectiveAt` et `staleAfter` sont requis, parce qu'une gratuité
 * jamais périmable est exactement le blanchiment que la décision 0078 interdit.
 */
export interface FreeTierPriceEntry {
  readonly kind: typeof FREE_TIER;
  readonly modelId: string;
  readonly currency: BudgetCurrency;
  readonly provider: string;
  readonly provenance: FreeTierProvenance;
  readonly conditions: string;
  readonly verifiedQuota: string;
  readonly effectiveAt: string;
  readonly staleAfter: string;
  readonly promptPerMillion?: never;
  readonly completionPerMillion?: never;
}

/**
 * Un enregistrement du registre que `recordDefect` REFUSE, projeté avec son défaut plutôt que
 * réécrit. Sans cette forme, la projection copiait les champs connus d'une gratuité et laissait
 * tomber ceux qu'elle interdit (un `promptMicrosPerMillion: 0` glissé par cast ou JSON) : le
 * registre disait INVALID_ENTRY, la table disait FREE_TIER. Une entrée refusée reste refusée.
 */
export interface RefusedPriceEntry {
  readonly kind: "REFUSED";
  readonly modelId: string;
  readonly defect: string;
}

export type PriceEntry = RatePriceEntry | FreeTierPriceEntry | RefusedPriceEntry;

export type PriceTable = Readonly<Record<string, PriceEntry>>;

/**
 * Péremption d'une entrée qui n'en déclare pas. Une entrée injectée à la main (seam de test
 * ou d'injection) ne porte pas d'horizon de fraîcheur, et lui en INVENTER un serait à la fois
 * une fabrication et une bombe à retardement dans les suites d'autres lots. Elle reste donc
 * validée (tarif strictement positif, devise, provenance, cohérence de clé) mais non périmable.
 * Les vrais tarifs n'entrent pas par là : ils entrent par `ICOS_PRICE_REGISTRY`, dont le type
 * EXIGE `effectiveAt` et `staleAfter`, et `ICOS_PRICE_TABLE` en est la projection gelée.
 */
const NEVER_STALE = "9999-12-31T00:00:00.000Z";

/** Projette le registre vers la forme héritée, en conservant provenance et fraîcheur. */
export function priceTableFrom(registry: PriceRegistry): PriceTable {
  const ambiguous = ambiguousModelIds(registry);
  const table: Record<string, PriceEntry> = {};
  for (const record of registry) {
    /* Deux tarifs concurrents : une table en écraserait un en silence. Aucun n'est projeté. */
    if (ambiguous.has(record.modelId)) continue;
    /* VALIDER AVANT DE PROJETER : la projection ne doit jamais rendre valide ce que le registre refuse. */
    const defect = recordDefect(record);
    if (defect !== null) {
      table[record.modelId] = { kind: "REFUSED", modelId: record.modelId, defect };
      continue;
    }
    if (record.kind === FREE_TIER) {
      /* Projetée telle quelle : aucun tarif n'est inventé pour une gratuité. */
      table[record.modelId] = {
        kind: FREE_TIER,
        modelId: record.modelId,
        currency: record.currency,
        provider: record.provider,
        provenance: record.provenance,
        conditions: record.conditions,
        verifiedQuota: record.verifiedQuota,
        effectiveAt: record.effectiveAt,
        staleAfter: record.staleAfter,
      };
      continue;
    }
    table[record.modelId] = {
      modelId: record.modelId,
      currency: record.currency,
      promptPerMillion: microsToAmount(record.promptMicrosPerMillion),
      completionPerMillion: microsToAmount(record.completionMicrosPerMillion),
      provenance: record.provenance,
      asOf: record.effectiveAt,
      provider: record.provider,
      effectiveAt: record.effectiveAt,
      staleAfter: record.staleAfter,
    };
  }
  return Object.freeze(table);
}

/**
 * VIDE, parce que le registre est vide. Gelée : on ne peut pas y glisser un tarif à
 * l'exécution pour contourner les dates exigées par `PriceRecord`.
 */
export const ICOS_PRICE_TABLE: PriceTable = priceTableFrom(ICOS_PRICE_REGISTRY);

/** Taux hérité (flottant par unité) vers micros entiers. `null` si non représentable. */
function toMicrosPerMillion(value: number): number | null {
  const scaled = value * MICROS_PER_UNIT;
  if (!Number.isFinite(scaled)) return null;
  const micros = Math.round(scaled);
  /*
   * Tolérance pour le bruit binaire (0,1 * 1e6 vaut 100000,00000000001), pas pour un tarif
   * réellement plus fin que le micro : celui-là n'est pas représentable, donc refusé.
   */
  if (Math.abs(scaled - micros) > 1e-3) return null;
  return micros;
}

/** Entrée héritée vers `PriceRecord`, ou le motif du refus. */
function toRecord(key: string, entry: PriceEntry): PriceRecord | string {
  if (entry.modelId !== key) return `entrée ${entry.modelId} rangée sous la clé ${key}`;
  if (entry.kind === "REFUSED") return entry.defect;
  const kind = (entry as { kind?: unknown }).kind;
  /* Un `kind` inconnu (JSON, cast) n'est pas un tarif par défaut. */
  if (kind !== undefined && kind !== "RATE" && kind !== FREE_TIER) {
    return `kind ${String(kind)} inconnu`;
  }
  if (entry.kind === FREE_TIER) {
    const loose = entry as unknown as Record<string, unknown>;
    if (loose.promptPerMillion !== undefined || loose.completionPerMillion !== undefined) {
      return "une gratuité ne porte aucun tarif";
    }
    const record: FreeTierPriceRecord = {
      kind: FREE_TIER,
      provider: entry.provider,
      modelId: entry.modelId,
      currency: entry.currency,
      provenance: entry.provenance,
      conditions: entry.conditions,
      verifiedQuota: entry.verifiedQuota,
      effectiveAt: entry.effectiveAt,
      staleAfter: entry.staleAfter,
    };
    return record;
  }
  if (entry.asOf.trim().length === 0) return "asOf absent";
  const promptMicrosPerMillion = toMicrosPerMillion(entry.promptPerMillion);
  const completionMicrosPerMillion = toMicrosPerMillion(entry.completionPerMillion);
  if (promptMicrosPerMillion === null) return "promptPerMillion invalide";
  if (completionMicrosPerMillion === null) return "completionPerMillion invalide";
  return {
    /* Le fournisseur n'existe pas dans la forme héritée : déduit du préfixe, jamais inventé. */
    provider: entry.provider ?? key.split("/")[0] ?? "",
    modelId: entry.modelId,
    currency: entry.currency,
    promptMicrosPerMillion,
    completionMicrosPerMillion,
    provenance: entry.provenance,
    effectiveAt: entry.effectiveAt ?? entry.asOf,
    staleAfter: entry.staleAfter ?? NEVER_STALE,
  };
}

/**
 * Chiffre une consommation mesurée. Signature inchangée (la couche dépense en dépend) ;
 * `now` est optionnel et ne sert qu'à rendre la fraîcheur testable.
 *
 * Tout le jugement est délégué au registre : validité, fraîcheur, tokens facturés sans
 * tarif, arithmétique en micros entiers. Ici il ne reste que la traduction de forme et
 * l'unique division vers `amount`.
 */
export function priceUsage(
  table: PriceTable,
  modelId: string,
  usage: TokenUsage,
  now: Date = new Date(),
): CostOutcome {
  const entry = Object.prototype.hasOwnProperty.call(table, modelId) ? table[modelId] : undefined;
  if (!entry) {
    return { kind: UNPRICED, modelId, reason: "modèle absent de la table de prix" };
  }

  const record = toRecord(modelId, entry);
  if (typeof record === "string") {
    return { kind: UNPRICED, modelId, reason: `entrée de prix inutilisable : ${record}` };
  }

  const outcome = priceUsageMicros([record], modelId, usage, now);
  if (outcome.kind === FREE_TIER) {
    return {
      kind: FREE_TIER,
      currency: outcome.currency,
      amount: 0,
      modelId,
      provenance: outcome.provenance,
    };
  }
  if (outcome.kind !== "COST_MICROS") {
    return { kind: UNPRICED, modelId, reason: outcome.reason };
  }
  return { kind: "COST", currency: BUDGET_CURRENCY, amount: microsToAmount(outcome.micros) };
}
