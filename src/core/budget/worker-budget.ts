import { UNMETERED, type TokenUsage, type UsageOutcome } from "./contracts";

/**
 * COMPTABILITÉ DES WORKERS EXTERNES (verrou « aucun worker n'échappe au budget du Goal »).
 *
 * ── LE PROBLÈME QUI EST PROPRE AUX WORKERS EXTERNES ─────────────────────────────────────
 * Un appel de complétion passe par la couture `fetch` d'ICOS : on le réserve, on le mesure,
 * on le solde. Un worker externe est un SOUS-PROCESSUS : il facture avec ses propres
 * identifiants, chez son propre fournisseur, et ne traverse aucune couture d'ICOS. Aucune
 * réservation ne peut donc le borner, et prétendre le contraire serait le mensonge le plus
 * coûteux de cette couche.
 *
 * ── CE QU'ON FAIT À LA PLACE, ET DANS CET ORDRE ─────────────────────────────────────────
 *   1. LIRE LA CONSOMMATION RÉELLE quand l'exécuteur la rapporte. Mesuré : Hermes l'écrit
 *      dans `--usage-file` (input/output/total, modèle, fournisseur) et Codex l'imprime.
 *      Quand elle est là, c'est elle qui compte — pas une estimation.
 *   2. QUAND ELLE N'EST PAS LÀ, appliquer un BUDGET DE SUBSTITUTION explicite et
 *      applicable : un nombre d'invocations, une horloge murale, une sortie maximale. Ce
 *      n'est PAS une mesure de tokens et ce module ne l'appelle jamais ainsi : c'est une
 *      borne sur ce qu'on autorise à lancer, pas sur ce qui a été consommé.
 *
 * Les deux coexistent : la substitution borne les LANCEMENTS, la mesure alimente la fenêtre
 * du goal quand elle existe. Un worker muet consomme donc du budget de substitution et
 * laisse une ligne UNMETERED — visible, jamais blanchie en zéro.
 */

/** Borne applicable SANS connaître les tokens. Chaque champ est vérifiable localement. */
export interface WorkerProxyBudget {
  /** Nombre maximum de lancements d'exécuteur externe pour ce goal. */
  readonly maxInvocations: number;
  /** Temps d'horloge cumulé maximum, tous workers de ce goal confondus. */
  readonly maxWallClockMs: number;
  /** Sortie maximale passée à l'exécuteur quand il sait la respecter. */
  readonly maxOutputTokens: number;
}

/**
 * Valeurs par défaut. Des bornes RÉELLES, pas des infinis déguisés : un goal qui lance
 * vingt workers d'une heure a franchi quelque chose, même si personne ne sait combien de
 * tokens cela représente.
 */
export const DEFAULT_WORKER_PROXY_BUDGET: WorkerProxyBudget = Object.freeze({
  maxInvocations: 20,
  maxWallClockMs: 60 * 60 * 1_000,
  maxOutputTokens: 8_192,
});

export interface WorkerProxyUsage {
  readonly invocations: number;
  readonly wallClockMs: number;
}

export const emptyWorkerUsage = (): WorkerProxyUsage => ({ invocations: 0, wallClockMs: 0 });

export type WorkerDispatchDecision =
  | { readonly kind: "ALLOW" }
  | {
      readonly kind: "DENY";
      readonly reason: "WORKER_INVOCATION_CAP" | "WORKER_WALL_CLOCK_CAP" | "INVALID_WORKER_BUDGET";
      readonly detail: string;
    };

/**
 * Peut-on lancer UN worker externe de plus pour ce goal ? Décidé AVANT le lancement, sur
 * des grandeurs qu'ICOS observe lui-même — on ne dépend pas de la bonne volonté du worker.
 */
export function decideWorkerDispatch(
  used: WorkerProxyUsage,
  budget: WorkerProxyBudget,
): WorkerDispatchDecision {
  for (const [name, value] of [
    ["maxInvocations", budget.maxInvocations],
    ["maxWallClockMs", budget.maxWallClockMs],
    ["maxOutputTokens", budget.maxOutputTokens],
  ] as const) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      return { kind: "DENY", reason: "INVALID_WORKER_BUDGET", detail: `${name}: ${String(value)}` };
    }
  }
  if (!(Number.isSafeInteger(used.invocations) && used.invocations >= 0)) {
    return { kind: "DENY", reason: "INVALID_WORKER_BUDGET", detail: "invocations inexploitable" };
  }
  if (used.invocations >= budget.maxInvocations) {
    return {
      kind: "DENY",
      reason: "WORKER_INVOCATION_CAP",
      detail: `${used.invocations} lancements pour un plafond de ${budget.maxInvocations}`,
    };
  }
  if (used.wallClockMs >= budget.maxWallClockMs) {
    return {
      kind: "DENY",
      reason: "WORKER_WALL_CLOCK_CAP",
      detail: `${used.wallClockMs} ms cumulées pour un plafond de ${budget.maxWallClockMs}`,
    };
  }
  return { kind: "ALLOW" };
}

/** Le temps restant autorisé : c'est le timeout que le lancement doit recevoir. */
export function remainingWallClockMs(used: WorkerProxyUsage, budget: WorkerProxyBudget): number {
  return Math.max(0, budget.maxWallClockMs - used.wallClockMs);
}

export function accumulateWorkerUsage(
  used: WorkerProxyUsage,
  run: { durationMs: number },
): WorkerProxyUsage {
  return {
    invocations: used.invocations + 1,
    wallClockMs: used.wallClockMs + Math.max(0, run.durationMs),
  };
}

/**
 * Ce qu'un exécuteur a RÉELLEMENT consommé, quand il le dit.
 *
 * `source` nomme d'où vient le chiffre (`hermes:usage-file`, `codex:stderr`), parce qu'une
 * mesure sans provenance ne se vérifie pas. Absente, on rend un UNMETERED avec sa raison :
 * jamais un zéro, qui ferait passer un worker coûteux pour gratuit.
 */
export type WorkerUsageReading =
  | {
      readonly kind: "MEASURED";
      readonly usage: TokenUsage;
      readonly source: string;
      readonly model?: string;
    }
  | { readonly kind: "UNMEASURED"; readonly reason: string };

/** Convertit une lecture de worker en observation du journal. Aucune invention. */
export function toUsageOutcome(reading: WorkerUsageReading): UsageOutcome {
  return reading.kind === "MEASURED"
    ? { kind: "METERED", usage: reading.usage }
    : /* Pas de tokens connus : UNMETERED, et la fenêtre du goal le saura. */
      { kind: UNMETERED, reason: "USAGE_ABSENT" };
}
