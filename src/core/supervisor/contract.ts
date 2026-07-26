import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

// ─────────────────────────────────────
// DAG Status — top-level DAG machine
// ─────────────────────────────────────

export const dagStatusSchema = z.enum([
  "CREATED",
  "SCHEDULING",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export type DagStatus = z.infer<typeof dagStatusSchema>;

export const TERMINAL_DAG_STATUSES: readonly DagStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

// ─────────────────────────────────────
// Task Node Status — per-node state machine
// ─────────────────────────────────────

/**
 * États d'un nœud du DAG Supervisor.
 *
 * Machine d'état :
 * PENDING ──→ READY ──→ ASSIGNED ──→ RUNNING ──→ REVIEWING ──→ SUCCEEDED
 *                          │            │            │
 *                          │            │       CHANGES_REQUIRED ──→ READY
 *                          │            │            │
 *                          │            │       FAILED_REVIEW ──→ READY (retry)
 *                          │       ─────┴────
 *                          │      │         │
 *                          │      ▼         ▼
 *                          │   FAILED    CANCELLED
 *                          │      │
 *                          │      ▼
 *                          │   BLOCKED
 *                          │
 *                     WAITING_FOR_HUMAN
 *
 * INVARIANT : les états terminaux (SUCCEEDED, FAILED, CANCELLED, BLOCKED)
 * n'ont aucune transition sortante.
 */
export const taskNodeStatusSchema = z.enum([
  "PENDING",
  "READY",
  "ASSIGNED",
  "RUNNING",
  "REVIEWING",
  "CHANGES_REQUIRED",
  "FAILED_REVIEW",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
  "WAITING_FOR_HUMAN",
]);

export type TaskNodeStatus = z.infer<typeof taskNodeStatusSchema>;

export const TERMINAL_NODE_STATUSES: readonly TaskNodeStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
];

export const SUSPENDED_NODE_STATUSES: readonly TaskNodeStatus[] = [
  "WAITING_FOR_HUMAN",
];

// ─────────────────────────────────────
// Worker assignment
// ─────────────────────────────────────

export const workerAssignmentSchema = z.object({
  workerId: z.string().min(1),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  workerSpec: z.unknown().optional(),
  workerResult: z.unknown().optional(),
});

export type WorkerAssignment = z.infer<typeof workerAssignmentSchema>;

// ─────────────────────────────────────
// Retry policy
// ─────────────────────────────────────

export const retryPolicySchema = z.object({
  maxRetries: z.number().int().nonnegative().default(2),
  retryDelayMs: z.number().int().nonnegative().default(1_000),
});

export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 2,
  retryDelayMs: 1_000,
};

// ─────────────────────────────────────
// Task Node
// ─────────────────────────────────────

export const taskNodeSchema = z.object({
  /** Identifiant unique du nœud dans le DAG. */
  id: idSchema,
  /** Libellé court et lisible (ex: "Implémenter le port WorkerManager"). */
  label: z.string().min(1),
  /** Description détaillée de la tâche. */
  description: z.string().min(1),
  /** Critères d'acceptation. */
  acceptanceCriteria: z.array(z.string()).default([]),
  /** État courant du nœud. */
  status: taskNodeStatusSchema.default("PENDING"),
  /** IDs des nœuds parents (dépendances directes). */
  dependsOn: z.array(z.string()).default([]),
  /** IDs des nœuds bloquants (résolus automatiquement ou manuellement). */
  blockedBy: z.array(z.string()).default([]),

  // Worker
  workerAssignments: z.array(workerAssignmentSchema).default([]),
  currentWorkerId: z.string().optional(),

  // Review
  reviewWorkerId: z.string().optional(),
  reviewResult: z.string().optional(), // "pass" | "changes_required" | "failed"
  correctionIds: z.array(z.string()).default([]),
  correctionCount: z.number().int().nonnegative().default(0),

  // Retry
  retryCount: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().nonnegative().default(2),

  // Horodatages
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
});

export type TaskNode = z.infer<typeof taskNodeSchema>;

// ─────────────────────────────────────
// Task DAG
// ─────────────────────────────────────

export const taskDagSchema = z.object({
  /** Identifiant unique du DAG. */
  id: idSchema,
  /** Mission propriétaire (D2). */
  missionId: z.string().min(1),
  /** Tenant propriétaire. */
  tenantId: z.string().min(1),
  /** État du DAG. */
  status: dagStatusSchema.default("CREATED"),
  /** Nœuds du DAG, indexés par ID. */
  nodes: z.record(z.string(), taskNodeSchema).default({}),
  /** Ordre topologique d'intégration (V2+). */
  nodeOrder: z.array(z.string()).default([]),
  /** Erreur globale du DAG (présente si FAILED). */
  error: z.string().optional(),

  // Horodatages
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
});

export type TaskDag = z.infer<typeof taskDagSchema>;

// ─────────────────────────────────────
// Create / Update inputs
// ─────────────────────────────────────

export interface CreateDagInput {
  id: string;
  missionId: string;
  tenantId: string;
  nodes: TaskNode[];
}

export interface AddNodeInput {
  dagId: string;
  node: TaskNode;
}

export interface UpdateNodeStatusInput {
  dagId: string;
  nodeId: string;
  targetStatus: TaskNodeStatus;
  /** Raison de la transition (obligatoire pour FAILED, CANCELLED, BLOCKED). */
  reason?: string;
  /** Résultat du worker (obligatoire pour SUCCEEDED après RUNNING). */
  workerResult?: unknown;
}

export interface TransitionDagStatusInput {
  dagId: string;
  targetStatus: DagStatus;
  reason?: string;
}
