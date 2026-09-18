import { z } from "zod";

/**
 * DigitalOS Execution Facade - Type Contracts (ICOS local copy)
 * Minimal, Zod-validated, serializable.
 * Kept in sync with DigitalOS execution-facade/types/contracts.ts
 */

// ============================================================
// INPUT CONTRACT
// ============================================================

export const ExecutionInputSchema = z.object({
  executionId: z.string().min(1),
  projectId: z.string().min(1),
  missionId: z.string().optional(),

  capability: z.enum(["website.build", "website.qa", "website.heal", "website.preview"]),

  client: z.record(z.string(), z.unknown()).optional(),
  slots: z.record(z.string(), z.unknown()).optional(),

  options: z
    .object({
      root: z.string().default("."),
      baseUrl: z.string().url().optional(),
      previewPort: z.number().int().min(1024).max(65535).default(4180),
      healMaxPasses: z.number().int().min(1).max(5).default(2),
    })
    .optional(),
});

export type ExecutionInput = z.infer<typeof ExecutionInputSchema>;

// ============================================================
// ARTIFACT
// ============================================================

export const ArtifactSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  url: z.string().url().optional(),
  mediaType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

// ============================================================
// EVIDENCE
// ============================================================

export const EvidenceSchema = z.object({
  type: z.string(),
  source: z.string(),
  path: z.string().optional(),
  url: z.string().url().optional(),
  timestamp: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

// ============================================================
// FINDING (normalized from gate/healer)
// ============================================================

export const FindingSchema = z.object({
  severity: z.enum(["PASS", "WARN", "BLOCK"]),
  check: z.string(),
  message: z.string(),
  where: z.string().optional(),
  category: z.string().optional(),
  repairability: z.enum(["auto", "content", "human"]).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

// ============================================================
// ERROR MODEL
// ============================================================

export const ExecutionErrorSchema = z.object({
  code: z.enum([
    "INVALID_INPUT",
    "BUILD_FAILED",
    "QA_BLOCKED",
    "HEAL_FAILED",
    "PREVIEW_FAILED",
    "INTERNAL_ERROR",
  ]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;

// ============================================================
// OUTPUT CONTRACT (ExecutionResult)
// ============================================================

export const ExecutionResultSchema = z.object({
  executionId: z.string(),
  projectId: z.string(),
  missionId: z.string().optional(),

  capability: z.string(),

  status: z.enum(["success", "blocked", "failure"]),

  artifacts: z.array(ArtifactSchema),
  evidence: z.array(EvidenceSchema),
  findings: z.array(FindingSchema),

  result: z.record(z.string(), z.unknown()).optional(),

  error: ExecutionErrorSchema.optional(),

  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
});

export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

// ============================================================
// HELPERS
// ============================================================

export function validateExecutionInput(input: unknown): ExecutionInput {
  return ExecutionInputSchema.parse(input);
}

export function createExecutionResult(
  input: ExecutionInput,
  status: ExecutionResult["status"],
  artifacts: Artifact[] = [],
  evidence: Evidence[] = [],
  findings: Finding[] = [],
  result?: Record<string, unknown>,
  error?: ExecutionError,
): ExecutionResult {
  const now = new Date().toISOString();
  return {
    executionId: input.executionId,
    projectId: input.projectId,
    missionId: input.missionId,
    capability: input.capability,
    status,
    artifacts,
    evidence,
    findings,
    result,
    error,
    startedAt: now,
    completedAt: now,
  };
}
