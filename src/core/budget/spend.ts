import {
  BUDGET_CURRENCY,
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
 */

export interface SpendObservation {
  readonly modelId: string;
  readonly usage: UsageOutcome;
  /** Absent quand `usage` est UNMETERED : il n'y a rien à chiffrer. */
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
  } else if (observation.cost?.kind === UNPRICED) {
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

export function decide(window: SpendWindow, cap: BudgetCap): SpendDecision {
  /* UNCAPPED est un choix explicite du propriétaire : on ne le contredit pas. */
  if (cap.kind === "UNCAPPED") return { kind: "ALLOW" };

  const hasMoneyCap = cap.maxAmount !== undefined;
  const hasTokenCap = cap.maxTotalTokens !== undefined;
  if (!hasMoneyCap && !hasTokenCap) {
    return deny("NO_ENFORCEABLE_CAP", "plafond CAPPED sans maxAmount ni maxTotalTokens");
  }

  if (cap.maxAmount !== undefined && !(Number.isFinite(cap.maxAmount) && cap.maxAmount > 0)) {
    return deny("INVALID_CAP", `maxAmount inexploitable : ${String(cap.maxAmount)}`);
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

  if (cap.maxAmount !== undefined) {
    /* Le blanchiment interdit : 0 EUR comptabilisé n'est pas 0 EUR dépensé. */
    if (window.unpricedCalls > 0) {
      return deny(
        "UNPRICED_USAGE_IN_WINDOW",
        `${window.unpricedCalls} appel(s) sans prix dans la fenêtre : total non prouvable sous ${cap.maxAmount} ${window.currency}`,
      );
    }
    if (window.amount >= cap.maxAmount) {
      return deny(
        "MONEY_CAP_REACHED",
        `${window.amount} ${window.currency} dépensés pour un plafond de ${cap.maxAmount}`,
      );
    }
  }

  return { kind: "ALLOW" };
}
