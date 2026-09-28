/**
 * Phase 7C — contrats de recovery généralisé (ADR-0027). Types purs, sans Next.js / Drizzle.
 */

export type RecoveryUnitKind =
  | "waiting_settled"
  | "dispatch_prepared_stale"
  | "dispatch_orphaned"
  /**
   * M7 — an EXTERNAL WORKER execution whose lease expired (decision 0039).
   *
   * Distinct from `dispatch_orphaned` because the EVIDENCE is different, and that
   * difference is the whole reason defect 17 survived M6.3. `dispatch_orphaned` asks
   * a `WorkflowProbe` whether a Temporal workflow is still alive; an external worker
   * has no workflow, so that probe answers `unknown` forever and the unit defers for
   * ever — detection without reassignment. For a process-based worker the EXECUTION
   * LEASE is the liveness signal: a live runner renews it, a dead one cannot.
   */
  | "dispatch_execution_abandoned";

export interface RecoveryUnitRef {
  kind: RecoveryUnitKind;
  /** Identifiant + empreinte de l'état observé : un scan périmé ne peut pas rejouer une unité résolue. */
  key: string;
  missionId: string;
}

export type RecoveryClaimResult =
  /** Ce process possède l'unité pour la durée de la lease. */
  | "claimed"
  /** Un autre propriétaire détient une lease vivante, ou un cooldown court encore. */
  | "held"
  /** Déjà résolue (ou déjà déclarée épuisée) : ne rien faire. */
  | "resolved"
  /** Budget de tentatives épuisé — retourné UNE seule fois, au process qui le constate (escalade). */
  | "exhausted";

/** Coordination durable des unités de reprise. L'horloge est celle de PostgreSQL. */
export interface RecoveryUnitRepository {
  claim(
    unit: RecoveryUnitRef,
    ownerToken: string,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<RecoveryClaimResult>;
  /** Terminal. Faux si la propriété a été perdue (lease reprise par un autre). */
  complete(unit: RecoveryUnitRef, ownerToken: string, outcome: string): Promise<boolean>;
  /** Libère sans compter de tentative, l'unité n'est réexaminable qu'après `cooldownMs`. */
  defer(
    unit: RecoveryUnitRef,
    ownerToken: string,
    reason: string,
    cooldownMs: number,
  ): Promise<boolean>;
  /** Compte une tentative échouée, code d'erreur stable, backoff avant nouvelle tentative. */
  fail(
    unit: RecoveryUnitRef,
    ownerToken: string,
    errorCode: string,
    backoffMs: number,
  ): Promise<boolean>;
}

/** Référence minimale d'un DispatchAttempt détecté par un scan (aucun prompt : pas de contenu en transit). */
export interface RecoveryDispatchRef {
  id: string;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  workflowId: string;
  attempt: number;
}

export interface WaitingSettledCandidate {
  missionId: string;
  runtimeUpdatedAt: Date;
}

export interface RecoveryScanOptions {
  limit: number;
  /** Ancienneté minimale (horloge DB) avant qu'un état soit considéré comme abandonné. */
  olderThanMs: number;
}

/** Détection des orphelins : requêtes bornées, calculées à chaque appel depuis PostgreSQL. */
export interface RecoveryScanner {
  listSettledWaiting(options: RecoveryScanOptions): Promise<WaitingSettledCandidate[]>;
  listStalePrepared(options: RecoveryScanOptions): Promise<RecoveryDispatchRef[]>;
  listOrphanedDispatched(options: RecoveryScanOptions): Promise<RecoveryDispatchRef[]>;
  /**
   * M7 — `dispatched` attempts whose EXECUTION LEASE has expired.
   *
   * Requires a lease owner to have existed: an attempt nobody ever leased was never
   * picked up by an external worker, and belongs to `listStalePrepared` /
   * `listOrphanedDispatched` instead. Never guesses.
   */
  listAbandonedExecutions(options: RecoveryScanOptions): Promise<RecoveryDispatchRef[]>;
}

export type WorkflowStatus =
  | "running"
  | "not_found"
  /** Clos (terminé/échoué/annulé/expiré) : sans callback ICOS, l'effet du worker est inconnu. */
  | "closed"
  /** Sonde indisponible : fail-closed, aucune décision destructrice. */
  | "unknown";

/** Port de sonde d'exécution (adaptateur Temporal en production). */
export interface WorkflowProbe {
  status(workflowId: string): Promise<WorkflowStatus>;
}
