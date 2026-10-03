import {
  UNMETERED,
  type Attribution,
  type DenyReason,
  type SpendDecision,
  type UsageOutcome,
} from "@/core/budget/contracts";
import {
  boundCompletionBody,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type BoundedRequest,
} from "@/core/budget/request-bounds";
import { readUsage } from "@/core/budget/usage";

import type { SpendLedgerPort, SpendReservation, SpendReservationPort } from "./ports";

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

/**
 * Deux minutes : nettement sous le bail de dix minutes du magasin de réservations, donc un
 * appel lent est prolongé quatre fois avant que son propre engagement puisse expirer.
 */
export const DEFAULT_HEARTBEAT_MS = 2 * 60 * 1_000;

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
  /**
   * RÉSERVATION AVANT DISPATCH (verrou C1). Présent, il remplace le contrôle pré-vol par un
   * engagement atomique : aucune complétion ne part sans que sa majoration de consommation
   * soit déjà retirée du plafond du goal.
   *
   * Absent, le décorateur garde le contrôle pré-vol seul. Ce n'est PAS un repli permissif :
   * c'est le mode de la couture des FRAIS OPÉRATIONNELS, qui est `UNCAPPED` par choix nommé
   * (voir `compose-spend.ts`) et pour laquelle il n'y a donc rien à engager. Toute couture
   * plafonnée doit le fournir, et `composeSpendMeters` ne monte plus la couture `mission`
   * sans lui.
   */
  readonly reservations?: SpendReservationPort;
  /** Sortie maximale imposée aux appelants muets. Voir {@link DEFAULT_MAX_OUTPUT_TOKENS}. */
  readonly maxOutputTokens?: number;
  /**
   * Période du battement de cœur qui prolonge le bail (verrou C3). Doit être nettement
   * inférieure au bail du magasin de réservations, sinon le bail expire entre deux battements.
   */
  readonly heartbeatMs?: number;
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
  /*
   * LA MESURE NE DOIT JAMAIS CASSER L'APPEL. `meteredFetch` est typé `typeof fetch`, donc
   * un `inner` conforme rend un vrai `Response` — mais un adaptateur de test, un proxy ou
   * un polyfill peut rendre un objet qui n'en a que la forme utile (`ok`, `json`). Lire
   * `headers.get` dessus lançait un TypeError, et ce TypeError remontait à l'appelant :
   * une réponse de fournisseur PARFAITEMENT valide devenait une panne, parce qu'on n'avait
   * pas pu la compter. Mesuré : un relecteur a échoué en `PROVIDER_FAILURE` pour cette
   * seule raison.
   *
   * Un objet qu'on ne sait pas inspecter est donc UNMETERED — une dépense non mesurée,
   * visible dans la fenêtre — et jamais une erreur. Compter est subordonné à servir.
   */
  const headers: unknown = (response as { headers?: unknown }).headers;
  const readHeader =
    typeof (headers as Headers | undefined)?.get === "function"
      ? (headers as Headers).get("content-type")
      : null;
  if (typeof response.clone !== "function" || !JSON_CONTENT_TYPE.test(readHeader ?? "")) {
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

/**
 * Prolonge le bail tant que l'appel vit, et ANNULE l'appel si le bail est perdu (verrou C3).
 *
 * Perdre le bail signifie que l'engagement ne compte plus pour personne : une autre
 * réservation a pu recevoir le même budget. Continuer à dépenser dessus ferait exister deux
 * fois le même plafond — précisément la double allocation que C3 interdit. On ne peut pas
 * dé-dépenser ce qui est déjà parti, mais on peut cesser d'en produire, et le dire.
 */
function heartbeat(
  reservations: SpendReservationPort,
  reservation: SpendReservation,
  periodMs: number,
): { signal: AbortSignal; stop: () => void; lost: () => boolean } {
  const controller = new AbortController();
  let lost = false;
  const timer = setInterval(() => {
    void reservations.renew(reservation).then(
      (renewed) => {
        if (renewed) return;
        lost = true;
        controller.abort(new Error("RESERVATION_LEASE_LOST"));
      },
      () => {
        /* Prolongation invérifiable = bail présumé perdu. Fermé par défaut. */
        lost = true;
        controller.abort(new Error("RESERVATION_LEASE_LOST"));
      },
    );
  }, periodMs);
  /* Ne jamais retenir le processus en vie pour un battement de cœur. */
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer), lost: () => lost };
}

export function meteredFetch(inner: typeof fetch, deps: MeteredFetchDeps): typeof fetch {
  const attribution = deps.attribution ?? null;
  const now = deps.now ?? (() => new Date());
  const outputCeiling = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  /** Contrôle pré-vol seul : aucune réservation à tenir, donc rien à solder ni à rendre. */
  const unreserved: typeof fetch = async (input, init) => {
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

  const reservations = deps.reservations;
  if (reservations === undefined) return unreserved;

  /**
   * RÉSERVER, BORNER, ÉMETTRE, SOLDER (verrou C1).
   *
   * L'ordre est la propriété. Le premier appel d'un goal ne « passe » plus parce que son
   * historique est vide : il doit tenir dans le plafond AVEC sa propre majoration, retirée du
   * budget AVANT que la requête touche le réseau. Et c'est `reserve()` — sérialisé en
   * PostgreSQL — qui le retire, donc W premiers appels simultanés ne peuvent pas s'accorder
   * chacun le budget entier.
   */
  const reserved: typeof fetch = async (input, init) => {
    /* Les requêtes non facturantes du même seam gardent le contrôle pré-vol, sans engagement. */
    if (!isCompletionRequest(input)) return unreserved(input, init);

    const bounded: BoundedRequest = boundCompletionBody(init?.body, outputCeiling);
    if (bounded.kind === "UNBOUNDABLE") {
      /* Pas de majoration connue = rien à réserver = rien à autoriser. */
      throw new BudgetDeniedError({
        kind: "DENY",
        reason: "UNBOUNDED_REQUEST",
        detail: bounded.detail,
      });
    }

    const outcome = await reservations.reserve(attribution, bounded.reservedTokens);
    if (outcome.kind === "DENY") throw new BudgetDeniedError(outcome);
    const { reservation } = outcome;

    const beat = heartbeat(reservations, reservation, heartbeatMs);
    const callerSignal = init?.signal;
    let response: Response;
    try {
      response = await inner(input, {
        ...init,
        /* La limite de sortie RÉELLEMENT émise, celle qui a été réservée. */
        body: bounded.body,
        signal: callerSignal ? AbortSignal.any([callerSignal, beat.signal]) : beat.signal,
      });
    } catch (cause) {
      /*
       * Rien n'est parti, ou rien n'est revenu : l'engagement est RENDU immédiatement. Sans
       * cela une rafale d'erreurs réseau gèlerait le budget du goal jusqu'à l'échéance des
       * baux — un refus de service produit par le mécanisme censé protéger la dépense.
       */
      await reservations.release(reservation).catch(() => undefined);
      if (beat.lost()) {
        throw new BudgetDeniedError({
          kind: "DENY",
          reason: "RESERVATION_LEASE_LOST",
          detail: "bail de réservation perdu pendant l'appel : appel interrompu",
        });
      }
      throw cause;
    } finally {
      beat.stop();
    }

    /* Non 2xx : pas de consommation facturée, donc l'engagement est rendu, pas soldé. */
    if (!response.ok) {
      await reservations.release(reservation).catch(() => undefined);
      return response;
    }

    const observed = await observe(response);
    try {
      /*
       * Le solde n'accepte AUCUNE imputation (verrou C2) : celle du journal est relue depuis
       * la ligne de réservation, sous le même verrou que `reserve`.
       */
      await reservations.settle(reservation, {
        modelId: observed.model ?? requestedModel(init) ?? "UNKNOWN",
        usage: observed.usage,
        at: now().toISOString(),
      });
    } catch (cause) {
      throw new BudgetLedgerError(cause);
    }

    return response;
  };

  return reserved;
}
