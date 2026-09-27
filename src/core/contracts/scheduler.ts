/**
 * Durable Scheduler (ADR-0025). PostgreSQL est la source de vérité ; ces types
 * décrivent une file de jobs différés revendiqués par lease (jeton par claim).
 */
export const SCHEDULED_JOB_KINDS = ["start_mission", "wake_mission", "probe_workers"] as const;
export type ScheduledJobKind = (typeof SCHEDULED_JOB_KINDS)[number];

export type ScheduledJobState = "scheduled" | "running" | "succeeded" | "dead" | "expired";

export interface ScheduledJob {
  id: string;
  kind: ScheduledJobKind;
  payload: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string;
  state: ScheduledJobState;
  priority: number;
  nextRunAt: Date;
  deadlineAt?: Date;
  attemptCount: number;
  maxAttempts: number;
  backoffBaseMs: number;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
  missionId?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface EnqueueScheduledJobInput {
  kind: ScheduledJobKind;
  payload: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string;
  /** Défaut : maintenant (horloge de la base). */
  runAt?: Date;
  priority?: number;
  deadlineAt?: Date;
  maxAttempts?: number;
  backoffBaseMs?: number;
  missionId?: string;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_BASE_MS = 5_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

export interface ScheduledJobRepository {
  /** Idempotent par `idempotencyKey` ; même clé + autre contenu => SCHEDULER_IDEMPOTENCY_CONFLICT. */
  enqueue(input: EnqueueScheduledJobInput): Promise<{ job: ScheduledJob; created: boolean }>;
  /**
   * Revendique atomiquement UN job dû (scheduled échu, ou running à lease expirée),
   * plus prioritaire d'abord. Expire les jobs dont la deadline est dépassée, tue ceux
   * qui ont épuisé leurs tentatives. Retourne null si rien n'est dû.
   */
  claimDue(owner: string, leaseMs: number): Promise<ScheduledJob | null>;
  /** Prolonge la lease ; false si le jeton n'est plus propriétaire. */
  renewLease(id: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Solde le job ; false si le jeton n'est plus propriétaire (fencing). */
  complete(id: string, owner: string): Promise<boolean>;
  /** Échec : retry avec backoff durable, ou `dead` (non retryable / tentatives épuisées). */
  fail(
    id: string,
    owner: string,
    error: string,
    options: { retryable: boolean },
  ): Promise<{ ok: boolean; state?: ScheduledJobState }>;
  getById(id: string): Promise<ScheduledJob | null>;
}
