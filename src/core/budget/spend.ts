import {
  BUDGET_CURRENCY,
  eurToMicros,
  MICROS_PER_EUR,
  UNMETERED,
  UNPRICED,
  type BudgetCap,
  type BudgetCurrency,
  type CostOutcome,
  type DenyReason,
  type SpendDecision,
  type UsageOutcome,
} from "./contracts";

/**
 * Accumulateur et décision, purs. Aucune E/S, aucune horloge, aucun état global.
 *
 * `decide` est un contrôle PRÉ-vol : on l'appelle avant d'émettre l'appel suivant, et un
 * plafond atteint refuse cet appel. Fermé par défaut : tout ce qui ne peut pas être prouvé
 * sous le plafond est refusé, y compris un total non chiffré ou non mesuré.
 *
 * ── POURQUOI `decide` SEUL NE BORNE RIEN (verrou P0-D) ──────────────────────────────────
 * Un contrôle pré-vol autorise d'après ce qui est DÉJÀ enregistré. W appelants simultanés
 * lisent donc la même fenêtre et obtiennent W autorisations : la borne croît avec le nombre
 * de workers (mesuré : 2 workers -> 10 tokens au-delà, 16 -> 150). `decideReservation`
 * ferme ça en ajoutant le terme qui manquait — les tokens DÉJÀ ENGAGÉS par les appels en
 * vol — pour que la somme (dépensé + engagé + demandé) soit comparée au plafond. Ce fichier
 * reste PUR : la simultanéité, elle, se règle en PostgreSQL
 * (`src/server/budget/postgres-spend-reservations.ts`), jamais en mémoire de processus.
 */

export interface SpendObservation {
  readonly modelId: string;
  readonly usage: UsageOutcome;
  /**
   * Absent UNIQUEMENT quand `usage` est UNMETERED : il n'y a alors rien à chiffrer.
   *
   * Une consommation MESURÉE doit porter un chiffrage — un coût ou un UNPRICED explicite.
   * Le type ne peut pas encore l'imposer (une union discriminée casserait la construction
   * de `in-memory-spend-ledger.ts`, hors du périmètre de ce lot), donc `accumulate` tient
   * l'invariant au moment de l'accumulation : mesuré sans coût = non chiffré, jamais gratuit.
   */
  readonly cost?: CostOutcome;
}

export interface SpendWindow {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly currency: BudgetCurrency;
  /** Somme des coûts CHIFFRÉS uniquement. Ce n'est le total réel que si `unpricedCalls === 0`. */
  readonly amount: number;
  readonly pricedCalls: number;
  readonly unpricedCalls: number;
  readonly unmeteredCalls: number;
  /** Les totaux ne sont plus exacts (débordement ou valeur non finie) : fenêtre inexploitable. */
  readonly saturated: boolean;
}

export function emptyWindow(): SpendWindow {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    currency: BUDGET_CURRENCY,
    amount: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    unmeteredCalls: 0,
    saturated: false,
  };
}

/** Addition bornée : au-delà de l'entier sûr on garde la borne et on signale la saturation. */
function addTokens(left: number, right: number): { value: number; saturated: boolean } {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    return { value: Number.MAX_SAFE_INTEGER, saturated: true };
  }
  return { value: sum, saturated: false };
}

export function accumulate(window: SpendWindow, observation: SpendObservation): SpendWindow {
  let saturated = window.saturated;

  let promptTokens = window.promptTokens;
  let completionTokens = window.completionTokens;
  let totalTokens = window.totalTokens;
  let unmeteredCalls = window.unmeteredCalls;

  if (observation.usage.kind === UNMETERED) {
    unmeteredCalls += 1;
  } else {
    const { usage } = observation.usage;
    const prompt = addTokens(promptTokens, usage.promptTokens);
    const completion = addTokens(completionTokens, usage.completionTokens);
    const total = addTokens(totalTokens, usage.totalTokens);
    promptTokens = prompt.value;
    completionTokens = completion.value;
    totalTokens = total.value;
    saturated = saturated || prompt.saturated || completion.saturated || total.saturated;
  }

  let amount = window.amount;
  let pricedCalls = window.pricedCalls;
  let unpricedCalls = window.unpricedCalls;

  if (observation.cost?.kind === "COST") {
    const sum = amount + observation.cost.amount;
    if (Number.isFinite(sum)) {
      amount = sum;
      pricedCalls += 1;
    } else {
      /* Un total non finissable ne doit pas se propager : on garde le dernier total sain. */
      saturated = true;
    }
  } else if (observation.cost?.kind === UNPRICED || observation.usage.kind !== UNMETERED) {
    /*
     * Coût UNPRICED, ou coût absent sur une consommation MESURÉE. Le second cas laissait les
     * tokens s'accumuler en laissant `amount`, `pricedCalls` et `unpricedCalls` intacts : la
     * fenêtre paraissait propre et n'importe quel plafond monétaire était déclaré satisfait.
     * Un coût qu'on n'a pas n'est pas un coût nul : il compte comme non chiffré.
     */
    unpricedCalls += 1;
  }

  return {
    calls: window.calls + 1,
    promptTokens,
    completionTokens,
    totalTokens,
    currency: window.currency,
    amount,
    pricedCalls,
    unpricedCalls,
    unmeteredCalls,
    saturated,
  };
}

const deny = (reason: DenyReason, detail: string): SpendDecision => ({
  kind: "DENY",
  reason,
  detail,
});

type CappedBudget = Extract<BudgetCap, { kind: "CAPPED" }>;

/**
 * LE SEUL endroit du dépôt qui connaît l'unité du plafond monétaire. Deux orthographes
 * existent le temps de la migration (voir `BudgetCap`) ; les fournir toutes les deux est
 * un refus, pas un arbitrage silencieux.
 */
type MoneyCapMicros =
  | { readonly kind: "NONE" }
  | { readonly kind: "MICROS"; readonly micros: number }
  | { readonly kind: "AMBIGUOUS" }
  | { readonly kind: "INVALID"; readonly detail: string };

export function moneyCapMicros(cap: CappedBudget): MoneyCapMicros {
  if (cap.maxCostMicros !== undefined && cap.maxAmount !== undefined) {
    return { kind: "AMBIGUOUS" };
  }
  if (cap.maxCostMicros !== undefined) {
    return Number.isSafeInteger(cap.maxCostMicros) && cap.maxCostMicros > 0
      ? { kind: "MICROS", micros: cap.maxCostMicros }
      : { kind: "INVALID", detail: `maxCostMicros inexploitable : ${String(cap.maxCostMicros)}` };
  }
  if (cap.maxAmount !== undefined) {
    /* Conversion de FRONTIÈRE : au-delà, plus aucun flottant n'est comparé. */
    const micros = eurToMicros(cap.maxAmount);
    return micros !== null && micros > 0
      ? { kind: "MICROS", micros }
      : { kind: "INVALID", detail: `maxAmount inexploitable : ${String(cap.maxAmount)}` };
  }
  return { kind: "NONE" };
}

/**
 * Dépense accumulée en micros ENTIERS, ARRONDIE VERS LE HAUT. `window.amount` vient de la
 * table de prix, qui est en EUR flottants (couche gelée, hors de ce lot) : la seule
 * conversion honnête est donc celle qui ne peut pas faire DISPARAÎTRE une fraction de micro.
 */
const spentMicros = (window: SpendWindow) => Math.ceil(window.amount * MICROS_PER_EUR);

export function decide(window: SpendWindow, cap: BudgetCap): SpendDecision {
  /* UNCAPPED est un choix explicite du propriétaire : on ne le contredit pas. */
  if (cap.kind === "UNCAPPED") return { kind: "ALLOW" };

  const money = moneyCapMicros(cap);
  if (money.kind === "AMBIGUOUS") {
    return deny("AMBIGUOUS_MONEY_CAP", "maxAmount ET maxCostMicros fournis : plafond ambigu");
  }
  if (money.kind === "INVALID") return deny("INVALID_CAP", money.detail);

  const hasTokenCap = cap.maxTotalTokens !== undefined;
  if (money.kind === "NONE" && !hasTokenCap) {
    return deny("NO_ENFORCEABLE_CAP", "plafond CAPPED sans maxCostMicros ni maxTotalTokens");
  }

  if (
    cap.maxTotalTokens !== undefined &&
    !(Number.isSafeInteger(cap.maxTotalTokens) && cap.maxTotalTokens > 0)
  ) {
    return deny("INVALID_CAP", `maxTotalTokens inexploitable : ${String(cap.maxTotalTokens)}`);
  }

  if (window.saturated || !Number.isFinite(window.amount) || !Number.isFinite(window.totalTokens)) {
    return deny("UNUSABLE_WINDOW", "les totaux accumulés ne sont plus exacts");
  }

  /* Une consommation non mesurée ne peut être prouvée sous aucun plafond. */
  if (window.unmeteredCalls > 0) {
    return deny(
      "UNMETERED_USAGE_IN_WINDOW",
      `${window.unmeteredCalls} appel(s) sans consommation mesurable dans la fenêtre`,
    );
  }

  if (cap.maxTotalTokens !== undefined && window.totalTokens >= cap.maxTotalTokens) {
    return deny(
      "TOKEN_CAP_REACHED",
      `${window.totalTokens} tokens consommés pour un plafond de ${cap.maxTotalTokens}`,
    );
  }

  if (money.kind === "MICROS") {
    /* Le blanchiment interdit : 0 EUR comptabilisé n'est pas 0 EUR dépensé. */
    if (window.unpricedCalls > 0) {
      return deny(
        "UNPRICED_USAGE_IN_WINDOW",
        `${window.unpricedCalls} appel(s) sans prix dans la fenêtre : total non prouvable sous ${money.micros} micro-${window.currency}`,
      );
    }
    if (spentMicros(window) >= money.micros) {
      return deny(
        "MONEY_CAP_REACHED",
        `${spentMicros(window)} micro-${window.currency} dépensés pour un plafond de ${money.micros}`,
      );
    }
  }

  return { kind: "ALLOW" };
}

/**
 * RÉSERVATION AVANT DISPATCH (verrou P0-D), partie PURE.
 *
 * `heldTokens` = somme des tokens des réservations VIVANTES de la même imputation, c'est-à-dire
 * les appels déjà autorisés mais pas encore soldés. C'est le terme qui manquait à `decide` :
 * sans lui, W appelants simultanés comparent tous le même « déjà dépensé » au plafond et
 * obtiennent tous un feu vert.
 *
 * Trois propriétés non négociables :
 *   1. REFUS, JAMAIS ROGNAGE. Une réservation qui ne tient pas est refusée en entier. Rien ne
 *      part avec un montant réduit en silence.
 *   2. HÉRITE DE TOUTES LES FERMETURES DU PRÉ-VOL. Elle appelle `decide`, l'autorité unique :
 *      fenêtre non mesurée, saturée ou plafond invalide refusent une réservation comme un appel.
 *   3. UN PLAFOND MONÉTAIRE SANS PRIX FERME. Une réservation est exprimée en TOKENS ; la
 *      convertir en euros demanderait un prix, et la table de prix est vide (lot X3). On ne
 *      fabrique pas ce prix : `UNPRICED_RESERVATION`. Un budget en TOKENS SEULS, lui, reste
 *      pleinement applicable — le prix en euros n'est pas un prérequis de l'autonomie.
 */
export function decideReservation(
  window: SpendWindow,
  heldTokens: number,
  requestedTokens: number,
  cap: BudgetCap,
): SpendDecision {
  if (!(Number.isSafeInteger(requestedTokens) && requestedTokens > 0)) {
    return deny("INVALID_RESERVATION", `tokens demandés inexploitables : ${requestedTokens}`);
  }
  if (!(Number.isSafeInteger(heldTokens) && heldTokens >= 0)) {
    return deny("UNUSABLE_WINDOW", `total des réservations vivantes inexploitable : ${heldTokens}`);
  }
  /* UNCAPPED est un choix explicite : il n'y a rien à ne pas dépasser. */
  if (cap.kind === "UNCAPPED") return { kind: "ALLOW" };

  const preflight = decide(window, cap);
  if (preflight.kind === "DENY") return preflight;

  if (moneyCapMicros(cap).kind === "MICROS") {
    return deny(
      "UNPRICED_RESERVATION",
      `réservation de ${requestedTokens} tokens non chiffrable sous un plafond monétaire`,
    );
  }

  /* `decide` a déjà validé `maxTotalTokens` ; sans lui il n'y aurait rien à appliquer. */
  if (cap.maxTotalTokens === undefined) {
    return deny("NO_ENFORCEABLE_CAP", "aucun plafond de tokens à réserver contre");
  }

  const committed = window.totalTokens + heldTokens + requestedTokens;
  if (!Number.isSafeInteger(committed)) {
    return deny("UNUSABLE_WINDOW", "le total engagé n'est plus un entier exact");
  }
  if (committed > cap.maxTotalTokens) {
    return deny(
      "RESERVATION_EXCEEDS_CAP",
      `${window.totalTokens} dépensés + ${heldTokens} réservés + ${requestedTokens} demandés ` +
        `= ${committed} pour un plafond de ${cap.maxTotalTokens}`,
    );
  }
  return { kind: "ALLOW" };
}

/** Ce qu'un solde a réellement coûté, rendu et dépassé. Rien n'est caché ni arrondi. */
export interface Settlement {
  readonly reservedTokens: number;
  /** `null` = consommation NON MESURÉE. Jamais un 0 de substitution. */
  readonly actualTokens: number | null;
  readonly releasedTokens: number;
  /** > 0 quand l'appel a consommé plus que réservé. Enregistré, jamais masqué. */
  readonly overrunTokens: number;
}

/**
 * SOLDE SUR LA CONSOMMATION RÉELLE. Le reliquat non consommé est rendu au goal, et un
 * DÉPASSEMENT est dit plutôt que caché — la réservation borne ce qu'on autorise à partir,
 * pas ce que le fournisseur a réellement facturé.
 *
 * Consommation NON MESURÉE : rien n'est libéré, parce qu'on ne sait pas ce qui a été consommé.
 * La ligne UNMETERED écrite au journal rend de surcroît la fenêtre du goal non prouvable, donc
 * `decide` refuse ensuite TOUT appel de ce goal : l'issue est strictement plus stricte qu'une
 * libération, et c'est voulu.
 */
export function settleReservation(reservedTokens: number, usage: UsageOutcome): Settlement {
  if (usage.kind === UNMETERED) {
    return { reservedTokens, actualTokens: null, releasedTokens: 0, overrunTokens: 0 };
  }
  const actualTokens = usage.usage.totalTokens;
  return {
    reservedTokens,
    actualTokens,
    releasedTokens: Math.max(0, reservedTokens - actualTokens),
    overrunTokens: Math.max(0, actualTokens - reservedTokens),
  };
}
