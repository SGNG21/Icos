/**
 * CHIEF SUPERVISOR vocabulary (decision 0065). Pure: no Next.js, Drizzle or PostgreSQL.
 *
 * This layer adds NO entity. A work class and an objective state are both DERIVED
 * descriptions of a Goal that other subsystems already own.
 */

/** ICOS doctrine order. Index 0 outranks index 1, and so on. */
export const WORK_CLASSES = [
  "USER",
  "CLIENT",
  "REVENUE",
  "SECURITY",
  "MAINTENANCE",
  "SELF_IMPROVEMENT",
  "RESEARCH",
] as const;
export type WorkClass = (typeof WORK_CLASSES)[number];

export const OBJECTIVE_STATES = [
  "RECEIVED",
  "CONTEXTUALIZED",
  "PLANNING",
  "DELEGATING",
  "EXECUTING",
  "REVIEWING",
  "REPAIRING",
  "DECISION_READY",
  "COMPLETED",
  "BLOCKED",
  "WAITING_FOR_HUMAN",
  "DEGRADED",
  "RECOVERING",
  "CANCELLED",
  "FAILED",
] as const;
export type ObjectiveState = (typeof OBJECTIVE_STATES)[number];

/**
 * The ONLY way this layer reports a fact it does not hold. Never 0, never "", never
 * a plausible substitute: a reader must be able to tell absent from measured.
 */
export const UNKNOWN = "UNKNOWN" as const;
export type Unknown = typeof UNKNOWN;
export type Maybe<T> = T | Unknown;
