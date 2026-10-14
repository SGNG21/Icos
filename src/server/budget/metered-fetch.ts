import {
  UNMETERED,
  type Attribution,
  type DenyReason,
  type SpendDecision,
  type UsageOutcome,
  attributionKey,
} from "@/core/budget/contracts";
import { compareServedModel } from "@/core/budget/model-substitution";
import {
  boundCompletionBody,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type BoundedRequest,
} from "@/core/budget/request-bounds";
import { readAnthropicStream, readUsage, type AnthropicStreamReading } from "@/core/budget/usage";

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

/**
 * Les chemins facturés : les cinq appelants OpenAI-compatibles postent sur le premier ; le
 * second est l'API Anthropic (`/v1/messages`) que la sortie mesurée des workers (Claude Code
 * via OmniRoute, voir `workers/metered-egress-proxy.ts`) fait passer par ce même décorateur.
 */
const COMPLETION_PATH = /\/v1\/(chat\/completions|messages)\/?$/;
const ANTHROPIC_PATH = /\/v1\/messages\/?$/;
const EVENT_STREAM = /^text\/event-stream\b/i;

/**
 * Seule une COMPLÉTION est une dépense. Le même fetch injecté sert aussi à des requêtes qui
 * ne facturent rien — `GET /v1/models` pour la découverte des modèles — dont la réponse est un
 * 2xx JSON sans `usage` : les enregistrer UNMETERED condamnait l'imputation entière dès la
 * première requête, sans décroissance ni remise à zéro.
 *
 * On décide d'après la REQUÊTE, et d'après le CHEMIN : `input` peut être une chaîne, une URL
 * ou un `Request`, et deviner d'après le corps serait bien moins fiable.
 */
function requestPath(input: RequestInfo | URL): string {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(href).pathname;
  } catch {
    /* URL relative : on teste le chemin brut, sans requête ni fragment. */
    return href.split(/[?#]/, 1)[0] ?? "";
  }
}

function isCompletionRequest(input: RequestInfo | URL): boolean {
  return COMPLETION_PATH.test(requestPath(input));
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
/** What one answer taught us: its consumption, and when nothing was measurable, why. */
interface Observation {
  readonly usage: UsageOutcome;
  readonly model?: string;
  readonly providerError?: AnthropicStreamReading["providerError"];
  readonly stream?: AnthropicStreamReading["stream"];
}

/**
 * A FAILED CALL IS NOT A CONSUMPTION. The non-2xx rule below already says so; this is its
 * streaming twin: a 2xx event-stream whose only content is a provider `error` event before any
 * `message_start` delivered nothing and counted nothing. Recording it UNMETERED would make the
 * goal's window refuse every later call (`UNMETERED_USAGE_IN_WINDOW`) — measured on the N1 lab,
 * 2026-10-12: one such stream, then every retry denied. The caller still receives the error.
 * A stream that is unreadable for any OTHER reason stays UNMETERED, with its shape logged.
 */
function failedBeforeAnyToken(observed: Observation): boolean {
  return observed.providerError !== undefined && observed.usage.kind === UNMETERED;
}

function logStreamDiagnostic(
  event: "SPEND_PROVIDER_ERROR_STREAM" | "SPEND_STREAM_UNMETERED",
  observed: Observation,
  modelId: string,
): void {
  console.warn(
    JSON.stringify({
      event,
      modelId,
      ...(observed.usage.kind === UNMETERED ? { reason: observed.usage.reason } : {}),
      ...(observed.providerError ? { providerError: observed.providerError } : {}),
      ...(observed.stream ? { bytes: observed.stream.bytes, events: observed.stream.events } : {}),
    }),
  );
}

/**
 * Emit only after persistence succeeds; absent counters remain unknown in the journal.
 * On stderr, like the stream diagnostics above: an operational line of counters, never a
 * result. `console.info` is reserved to nothing in shipped source (no-debug-logging.test.ts).
 */
function logUsageSplit(
  usage: UsageOutcome,
  modelId: string,
  attribution: Attribution | null,
): void {
  if (usage.kind !== "METERED") return;
  const { promptTokens, completionTokens, cache } = usage.usage;
  console.warn(
    JSON.stringify({
      event: "SPEND_USAGE_SPLIT",
      modelId,
      attribution: attribution ? attributionKey(attribution) : null,
      prompt: promptTokens,
      fresh:
        cache?.read !== undefined && cache.creation !== undefined
          ? promptTokens - cache.read - cache.creation
          : null,
      cacheRead: cache?.read ?? null,
      cacheCreation: cache?.creation ?? null,
      output: completionTokens,
    }),
  );
}

/** OmniRoute's resolved backend model, sent beside the body (chatCore.ts:4594-4600). */
const SERVED_MODEL_HEADER = "x-omniroute-model";

function servedModelHeader(response: Response): string | undefined {
  const headers: unknown = (response as { headers?: unknown }).headers;
  if (typeof (headers as Headers | undefined)?.get !== "function") return undefined;
  const value = (headers as Headers).get(SERVED_MODEL_HEADER)?.trim();
  return value ? value : undefined;
}

/**
 * THE MODEL THE LEDGER RECORDS — the most reliable SERVED identity available, in this order:
 *
 *   1. `X-OmniRoute-Model`: the gateway's resolved backend model, set from the same `model`
 *      variable on the non-streaming path (chatCore.ts:4584-4586 → nonStreamingResponseHeaders.ts:34-36)
 *      and the streaming path (chatCore.ts:4697-4700 → streamingResponseHeaders.ts:26-28 →
 *      responseHeaders.ts:186), written by omnirouteResponseMeta.ts:159-161. The opt-in
 *      `echoRequestedModelName` rewrites the BODY (chatCore.ts:4601-4602) and the SSE chunks
 *      (streamingPipeline.ts:111-114) to the REQUESTED name, never this header;
 *   2. the body's `model` (equal to the header when echo is off, chatCore.ts:4594-4600);
 *   3. the requested model; 4. `UNKNOWN`.
 * Without (1), a gateway with echo on would make the ledger price the model ICOS ASKED for
 * while another one served. Header presence on streams is read from the gateway source, not
 * measured live; when it is absent (another gateway, or an older build), (2) is all there is.
 */
function ledgerModelId(
  header: string | undefined,
  observed: Observation,
  init: RequestInit | undefined,
): string {
  return header ?? observed.model ?? requestedModel(init) ?? "UNKNOWN";
}

/**
 * SERVED ≠ REQUESTED (decision 0078 §3, runtime half). A gateway combo, pattern mapping or
 * routing override bound to a concrete-looking id is invisible to `isMetaRoute`; the answer is
 * the only place it shows. Both the body `model` and `X-OmniRoute-Model` are compared, because
 * the gateway's opt-in `echoRequestedModelName` rewrites the BODY back to the requested name
 * (open-sse/services/responseModelEcho.ts:1-12) but not the header.
 *
 * A NAMED REPORT, NOT A REFUSAL, on every seam (goal, conversation, operational). Why not deny:
 *   - the spend is already made when the answer arrives, and the ledger records it under the
 *     SERVED identity (`ledgerModelId`: the `X-OmniRoute-Model` header first, then the body),
 *     so a paid substitute is priced as itself, or UNPRICED and then closes a money-capped
 *     window by itself (`decide`). That holds only as far as the gateway tells the truth in
 *     that header: without it and with echo on, the body names the requested model;
 *   - denying LATER calls of the same goal needs a durable substitution count in the spend
 *     window, i.e. a new ledger column, a migration and a new `DenyReason` — a contract change
 *     that deserves its own ADR, not a side effect of this lot;
 *   - the comparison has known false positives (a provider model alias canonicalised by the
 *     gateway), and a refusal on a false positive would stop autonomy for nothing.
 * Emitted only after persistence succeeded, like the usage split.
 */
function reportSubstitution(
  init: RequestInit | undefined,
  observed: Observation,
  header: string | undefined,
  attribution: Attribution | null,
): void {
  const requested = requestedModel(init);
  if (requested === undefined) return;
  for (const served of [observed.model, header]) {
    if (served === undefined) continue;
    const verdict = compareServedModel(requested, served);
    if (verdict.kind === "SAME") continue;
    console.warn(
      JSON.stringify({
        event: "SPEND_MODEL_SUBSTITUTED",
        reason: verdict.kind,
        requested,
        served: observed.model ?? null,
        servedHeader: header ?? null,
        attribution: attribution ? attributionKey(attribution) : null,
      }),
    );
    return;
  }
}

async function observe(response: Response, input: RequestInfo | URL): Promise<Observation> {
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
  /*
   * UN FLUX ANTHROPIC EST LU EN ENTIER, et c'est délibéré. Sa consommation n'arrive qu'à la
   * fin (`message_delta`), et l'enregistrer UNMETERED condamnerait la fenêtre du goal dès le
   * premier tour d'un agent. Le prix : l'appelant reçoit le flux d'un bloc, une fois la
   * complétion finie — la complétion reste correcte, seule la progressivité est perdue.
   * Limité au chemin Anthropic : les appelants OpenAI-compatibles gardent leur comportement.
   */
  if (
    typeof response.clone === "function" &&
    EVENT_STREAM.test(readHeader ?? "") &&
    ANTHROPIC_PATH.test(requestPath(input))
  ) {
    try {
      return readAnthropicStream(await response.clone().text());
    } catch {
      return { usage: { kind: UNMETERED, reason: "NON_JSON_BODY" } };
    }
  }
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

    const observed = await observe(response, input);
    const servedHeader = servedModelHeader(response);
    const modelId = ledgerModelId(servedHeader, observed, init);
    if (failedBeforeAnyToken(observed)) {
      logStreamDiagnostic("SPEND_PROVIDER_ERROR_STREAM", observed, modelId);
      return response;
    }
    if (observed.stream && observed.usage.kind === UNMETERED) {
      logStreamDiagnostic("SPEND_STREAM_UNMETERED", observed, modelId);
    }
    try {
      await deps.ledger.record({
        modelId,
        usage: observed.usage,
        attribution,
        at: now().toISOString(),
      });
    } catch (cause) {
      throw new BudgetLedgerError(cause);
    }
    logUsageSplit(observed.usage, modelId, attribution);
    reportSubstitution(init, observed, servedHeader, attribution);

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

    const observed = await observe(response, input);
    const servedHeader = servedModelHeader(response);
    const modelId = ledgerModelId(servedHeader, observed, init);
    if (failedBeforeAnyToken(observed)) {
      /* Like a non-2xx: the reservation is given back, nothing is settled. */
      logStreamDiagnostic("SPEND_PROVIDER_ERROR_STREAM", observed, modelId);
      await reservations.release(reservation).catch(() => undefined);
      return response;
    }
    if (observed.stream && observed.usage.kind === UNMETERED) {
      logStreamDiagnostic("SPEND_STREAM_UNMETERED", observed, modelId);
    }
    let settledAttribution: Attribution | null;
    try {
      /*
       * Le solde n'accepte AUCUNE imputation (verrou C2) : celle du journal est relue depuis
       * la ligne de réservation, sous le même verrou que `reserve`.
       */
      const settlement = await reservations.settle(reservation, {
        modelId,
        usage: observed.usage,
        at: now().toISOString(),
      });
      settledAttribution = settlement.attributedTo;
    } catch (cause) {
      throw new BudgetLedgerError(cause);
    }

    logUsageSplit(observed.usage, modelId, settledAttribution);
    reportSubstitution(init, observed, servedHeader, settledAttribution);

    return response;
  };

  return reserved;
}
