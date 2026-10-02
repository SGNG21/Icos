import {
  UNMETERED,
  type Attribution,
  type DenyReason,
  type SpendDecision,
  type UsageOutcome,
} from "@/core/budget/contracts";
import { readUsage } from "@/core/budget/usage";

import type { SpendLedgerPort } from "./ports";

/**
 * LE point d'application du budget (verrou d'autonomie B1).
 *
 * Les cinq appels de complétion OmniRoute passent tous par une valeur typée `typeof fetch`
 * (`fetchImpl` / `doFetch`), injectable. Un seul décorateur de cette forme les mesure donc
 * tous, sans toucher une ligne d'aucun des cinq appelants. C'est la raison d'être de ce
 * fichier : il n'y a qu'UN compteur, pas cinq.
 *
 * Invariants :
 * - le refus arrive AVANT `inner` : un appel refusé n'est jamais émis ;
 * - seule une requête de complétion est MESURÉE ; les autres requêtes du même seam
 *   (`GET /v1/models`) n'écrivent rien, mais restent soumises au contrôle pré-vol ;
 * - la réponse rendue est l'objet de `inner`, intact et entièrement lisible — la mesure lit
 *   un `clone()` ;
 * - une erreur ou une annulation de l'appelant remonte telle quelle et n'écrit rien ;
 * - une réponse sans consommation lisible est enregistrée UNMETERED, jamais 0.
 */

const DENIED_ERROR_NAME = "BudgetDeniedError";

/** Levée AVANT l'appel, quand le journal refuse la dépense. Une seule erreur typée. */
export class BudgetDeniedError extends Error {
  readonly name = DENIED_ERROR_NAME;
  readonly reason: DenyReason;
  constructor(decision: Extract<SpendDecision, { kind: "DENY" }>) {
    super(`BUDGET_DENIED:${decision.reason} ${decision.detail}`);
    this.reason = decision.reason;
  }
}

/**
 * Levée quand l'appel a réussi mais que le journal n'a pas pu enregistrer la dépense.
 * On échoue bruyamment : avaler l'erreur ferait du compteur un compteur ouvert, c'est-à-dire
 * exactement le défaut que ce lot ferme. La réponse de `inner` n'a pas été consommée.
 */
export class BudgetLedgerError extends Error {
  readonly name = "BudgetLedgerError";
  constructor(cause: unknown) {
    super("BUDGET_LEDGER_UNAVAILABLE", { cause });
  }
}

export interface MeteredFetchDeps {
  readonly ledger: SpendLedgerPort;
  /** Imputation des appels passant par CE décorateur. Absente = appel non attribué. */
  readonly attribution?: Attribution;
  readonly now?: () => Date;
}

const JSON_CONTENT_TYPE = /^application\/(\w+\+)?json\b/i;

/** Le seul chemin facturé : les cinq appelants postent tous là. */
const COMPLETION_PATH = /\/v1\/chat\/completions\/?$/;

/**
 * Seule une COMPLÉTION est une dépense. Le même fetch injecté sert aussi à des requêtes qui
 * ne facturent rien — `GET /v1/models` pour la découverte des modèles — dont la réponse est un
 * 2xx JSON sans `usage` : les enregistrer UNMETERED condamnait l'imputation entière dès la
 * première requête, sans décroissance ni remise à zéro.
 *
 * On décide d'après la REQUÊTE, et d'après le CHEMIN : `input` peut être une chaîne, une URL
 * ou un `Request`, et deviner d'après le corps serait bien moins fiable.
 */
function isCompletionRequest(input: RequestInfo | URL): boolean {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return COMPLETION_PATH.test(new URL(href).pathname);
  } catch {
    /* URL relative : on teste le chemin brut, sans requête ni fragment. */
    return COMPLETION_PATH.test(href.split(/[?#]/, 1)[0] ?? "");
  }
}

/** Le modèle demandé, quand le corps de requête est une chaîne JSON (les cinq appelants). */
function requestedModel(init: RequestInit | undefined): string | undefined {
  /*
   * Plafond assumé : on ne lit que `init.body` sous forme de chaîne. Un `Request` ou un flux
   * en entrée laisse le modèle inconnu — donc UNPRICED, donc fermé. Aucun des cinq appelants
   * n'est dans ce cas.
   */
  if (typeof init?.body !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const model = (parsed as { model?: unknown }).model;
      if (typeof model === "string" && model.trim().length > 0) return model;
    }
  } catch {
    /* Corps non JSON : le modèle reste inconnu. */
  }
  return undefined;
}

/**
 * Lit la consommation sur un CLONE. Un corps qui n'est pas annoncé JSON n'est même pas
 * cloné : lire un flux SSE jusqu'au bout attendrait la fin de la complétion et casserait
 * le streaming de l'appelant.
 */
async function observe(response: Response): Promise<{ usage: UsageOutcome; model?: string }> {
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
    return { usage: { kind: UNMETERED, reason: "NON_JSON_BODY" } };
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return { usage: { kind: UNMETERED, reason: "NON_JSON_BODY" } };
  }

  const usage = readUsage(payload);
  /* Le modèle rapporté par la réponse est celui qui a réellement tourné, donc qui facture. */
  const reported =
    typeof payload === "object" && payload !== null
      ? (payload as { model?: unknown }).model
      : undefined;
  return {
    usage,
    ...(typeof reported === "string" && reported.trim().length > 0 ? { model: reported } : {}),
  };
}

export function meteredFetch(inner: typeof fetch, deps: MeteredFetchDeps): typeof fetch {
  const attribution = deps.attribution ?? null;
  const now = deps.now ?? (() => new Date());

  const metered: typeof fetch = async (input, init) => {
    const decision = await deps.ledger.checkBudget(attribution);
    if (decision.kind === "DENY") throw new BudgetDeniedError(decision);

    /* Erreur réseau, annulation, délai dépassé : rien à mesurer, rien à écrire. */
    const response = await inner(input, init);

    /*
     * Une réponse non 2xx n'a pas de consommation et n'est pas facturée : on n'écrit AUCUNE
     * observation. Enregistrer un UNMETERED ici empoisonnerait la fenêtre au premier 429 et
     * bloquerait le système pour une erreur transitoire.
     */
    if (!response.ok) return response;

    /*
     * Rien à mesurer sur une requête qui n'est pas une complétion : aucune observation n'est
     * écrite. Attention à la sur-correction : une complétion dont la consommation est
     * illisible (flux SSE) reste enregistrée UNMETERED ci-dessous — c'est une vraie dépense
     * qu'ICOS n'a pas pu mesurer, la laisser passer rouvrirait le trou que ce fichier ferme.
     */
    if (!isCompletionRequest(input)) return response;

    const observed = await observe(response);
    try {
      await deps.ledger.record({
        modelId: observed.model ?? requestedModel(init) ?? "UNKNOWN",
        usage: observed.usage,
        attribution,
        at: now().toISOString(),
      });
    } catch (cause) {
      throw new BudgetLedgerError(cause);
    }

    return response;
  };

  return metered;
}
