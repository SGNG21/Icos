import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

// ─────────────────────────────────────
// Mission Status — State machine
// ─────────────────────────────────────

export const missionStatusSchema = z.enum([
  "CREATED",
  "PLANNING",
  "PLANNED",
  "IN_PROGRESS",
  "WAITING_FOR_APPROVAL",
  "BLOCKED_BY_POLICY",
  "PROVIDER_UNAVAILABLE",
  "TOOL_FAILED",
  "SKILL_REVOKED",
  "STALE_ATTESTATION",
  "MISSION_RECOVERABLE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export type MissionStatus = z.infer<typeof missionStatusSchema>;

/** États terminaux : aucune transition possible. */
export const TERMINAL_STATUSES: readonly MissionStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

/** États suspendus (attente d'un événement externe pour reprendre). */
export const SUSPENDED_STATUSES: readonly MissionStatus[] = [
  "WAITING_FOR_APPROVAL",
  "BLOCKED_BY_POLICY",
  "PROVIDER_UNAVAILABLE",
  "TOOL_FAILED",
  "STALE_ATTESTATION",
  "MISSION_RECOVERABLE",
  "SKILL_REVOKED",
];

// ─────────────────────────────────────
// Step Result
// ─────────────────────────────────────

export const stepResultSchema = z.object({
  output: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});

export type StepResult = z.infer<typeof stepResultSchema>;

// ─────────────────────────────────────
// Step
// ─────────────────────────────────────

export const stepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
]);

export const stepSchema = z.object({
  id: idSchema,
  description: z.string().min(1),
  agentId: z.string().optional(),
  skillKey: z.string().optional(),
  toolRef: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  status: stepStatusSchema.default("pending"),
  result: stepResultSchema.optional(),
});

export type Step = z.infer<typeof stepSchema>;

// ─────────────────────────────────────
// Plan
// ─────────────────────────────────────

export const planSchema = z.object({
  steps: z.array(stepSchema).min(1),
  totalSteps: z.number().int().positive(),
  description: z.string(),
});

export type Plan = z.infer<typeof planSchema>;

// ─────────────────────────────────────
// Run
// ─────────────────────────────────────

export const runStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);

export const runSchema = z.object({
  id: idSchema,
  missionId: idSchema,
  stepIndex: z.number().int().nonnegative(),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  status: runStatusSchema.default("pending"),
  error: z.string().optional(),
  output: z.unknown().optional(),
});

export type Run = z.infer<typeof runSchema>;

// ─────────────────────────────────────
// Mission
// ─────────────────────────────────────

export const missionSchema = z.object({
  id: idSchema,
  tenantId: z.string().min(1),
  userRequest: z.string().min(1),
  status: missionStatusSchema.default("CREATED"),
  plan: planSchema.optional(),
  runs: z.array(runSchema).default([]),
  error: z.string().optional(),
  currentRunId: z.string().optional(),
  approvedBy: z.string().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
});

export type Mission = z.infer<typeof missionSchema>;

// ─────────────────────────────────────
// Commands (exported types)
// ─────────────────────────────────────

export interface CreateMissionInput {
  userRequest: string;
  tenantId: string;
}

export interface TransitionStatusInput {
  missionId: string;
  targetStatus: MissionStatus;
  /** Raison de la transition (obligatoire pour FAILED, CANCELLED, BLOCKED, etc.). */
  reason?: string;
  /** Approbateur (obligatoire pour transitions WAITING_FOR_APPROVAL → IN_PROGRESS). */
  approvedBy?: string;
  actorLabel: string;
}

export interface AddRunInput {
  missionId: string;
  stepIndex: number;
}

export interface SetPlanInput {
  missionId: string;
  plan: Plan;
  actorLabel: string;
}

/**
 * Résultat d'une opération D2.
 */
export type MissionResult<T> =
  { ok: true; data: T } | { ok: false; reason: string; message: string };
