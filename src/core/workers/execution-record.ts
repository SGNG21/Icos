import type { WorkerUsageReading } from "@/core/budget/worker-budget";

/**
 * L'UNIQUE PIÈCE DURABLE D'UNE EXÉCUTION EXTERNE (verrou C8 §8).
 *
 * ── POURQUOI UNE SEULE ──────────────────────────────────────────────────────────────────
 * Les faits d'une exécution étaient dispersés : la tentative dans le journal de dispatch,
 * la sortie dans le résultat du processus, les octrois d'identifiants nulle part, le
 * confinement nulle part. Pour répondre à « qu'est-ce qui a tourné, pour quel goal, avec
 * quel modèle, confiné comment, et qu'est-ce que ça a coûté ? » il fallait recouper
 * plusieurs sources — autant dire que personne ne le faisait.
 *
 * ── CE QUI NE PEUT PAS Y ENTRER ─────────────────────────────────────────────────────────
 * AUCUNE VALEUR DE SECRET. Les octrois sont des identifiants de capacité, un type et une
 * cible ; il n'existe aucun champ capable de porter une clé. Ce n'est pas une discipline de
 * journalisation qu'on peut oublier : c'est le type.
 *
 * ── CE QU'IL DIT SUR CE QU'IL NE SAIT PAS ───────────────────────────────────────────────
 * `usage` est une LECTURE, pas un nombre : `UNMEASURED` avec sa raison quand l'exécuteur
 * s'est tu. `cost` n'existe pas, parce qu'aucun exécuteur ne le rapporte de façon fiable
 * (Hermes écrit lui-même `cost_status: "unknown"`). Un champ coût rempli de zéros serait
 * une fabrication ; son absence est la vérité.
 */

/** Comment l'exécution s'est terminée. Un état, pas une interprétation. */
export const EXECUTION_OUTCOMES = [
  "COMPLETED",
  /** Délai dépassé : l'arbre de processus a été tué. */
  "TIMED_OUT",
  /** Annulé par ICOS (contrôle, arrêt de mission). */
  "CANCELLED",
  /** Le bail a expiré pendant le travail : le résultat ne peut pas être retenu. */
  "LEASE_LOST",
  /** Abandonné : le processus a disparu sans verdict, récupéré par un balayage. */
  "ABANDONED",
  "FAILED",
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

/** Un octroi d'identifiant. Des NOMS et des instants, jamais une valeur. */
export interface ExecutionCredentialGrant {
  readonly capabilityId: string;
  readonly kind: "env" | "file";
  /** Nom de variable ou chemin relatif. Pas un contenu. */
  readonly target: string;
  readonly grantedAt: string;
  /** Rempli quand le HOME jetable a réellement été détruit. */
  readonly revokedAt?: string;
}

export interface ExecutionRecord {
  readonly executionId: string;
  /* --- à quoi ce travail appartient ------------------------------------------------- */
  readonly goalId: string | null;
  readonly missionId: string;
  readonly taskId: string;
  /** Le cerveau à qui la tâche est affectée. `null` quand aucune affectation ne la porte. */
  readonly brainId: string | null;
  readonly workerId: string | null;
  /* --- avec quoi ------------------------------------------------------------------- */
  readonly executor: string;
  readonly provider: string | null;
  readonly model: string | null;
  /* --- où --------------------------------------------------------------------------- */
  readonly worktree: string;
  /** Ce qui a RÉELLEMENT confiné, pas ce qu'on croyait configurer. */
  readonly confinement: "seatbelt" | "none";
  /** Le réseau a-t-il été refusé PAR L'OS ? Faux dès qu'un endpoint est nécessaire. */
  readonly networkEnforced: boolean;
  /* --- quand ------------------------------------------------------------------------ */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /* --- ce qui s'est passé ------------------------------------------------------------ */
  readonly outcome: ExecutionOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Lecture de consommation. Jamais un zéro de substitution. */
  readonly usage: WorkerUsageReading;
  /** Résumé des fichiers touchés. Des chemins, jamais un contenu. */
  readonly filesChanged: readonly string[];
  readonly commitBefore: string | null;
  readonly commitAfter: string | null;
  readonly credentialGrants: readonly ExecutionCredentialGrant[];
  /** Ce travail exige-t-il une relecture avant d'être retenu ? */
  readonly reviewRequired: boolean;
}

/**
 * Déduit l'issue des faits observés, dans un ordre de priorité qui ne ment pas :
 * un bail perdu l'emporte sur un code de sortie 0, parce qu'un résultat qu'on n'a plus le
 * droit de retenir n'est pas un succès, quoi qu'en dise le processus.
 */
export function executionOutcomeOf(facts: {
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly lostLease?: boolean;
  readonly exitCode: number | null;
}): ExecutionOutcome {
  if (facts.lostLease) return "LEASE_LOST";
  if (facts.cancelled) return "CANCELLED";
  if (facts.timedOut) return "TIMED_OUT";
  if (facts.exitCode === 0) return "COMPLETED";
  /* `null` sans délai dépassé : le processus n'a jamais rendu de verdict. */
  return facts.exitCode === null ? "ABANDONED" : "FAILED";
}

/**
 * Un enregistrement ne doit JAMAIS porter de secret. Le type l'interdit déjà ; ceci est la
 * vérification de dernier recours, pour un champ libre ajouté plus tard sans y penser.
 */
export function recordLeaksSecret(record: ExecutionRecord, secrets: readonly string[]): boolean {
  const serialized = JSON.stringify(record);
  return secrets.some((secret) => secret.length > 0 && serialized.includes(secret));
}
