import { z } from "zod";

const selfStateIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

const sourceIdSchema = selfStateIdSchema;

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
    "repository path must be relative and must not traverse parents",
  );

export const selfStateSourceSchema = z
  .object({
    id: sourceIdSchema,
    kind: z.enum(["VERSIONED_STATE", "REPOSITORY_DOCUMENT", "REPOSITORY_CODE"]),
    path: repositoryPathSchema,
    schemaVersion: z.literal(1).optional(),
  })
  .strict();

const milestoneSchema = z
  .object({
    id: selfStateIdSchema,
    label: z.string().min(1).max(160),
  })
  .strict();

const currentMilestoneSchema = milestoneSchema
  .extend({
    status: z.literal("IN_PROGRESS"),
  })
  .strict();

const blockerSchema = z
  .object({
    id: selfStateIdSchema,
    description: z.string().min(1).max(500),
    provenance: z.array(sourceIdSchema).min(1).max(8),
  })
  .strict();

export const capabilityReferenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("UNKNOWN"),
      source: sourceIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("UNAVAILABLE"),
      source: sourceIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("AVAILABLE"),
      source: sourceIdSchema,
    })
    .strict(),
]);

export const protectedAreasSchema = z.tuple([
  z.literal("D1_POLICY_DECISIONS"),
  z.literal("G1_AUTHORITY_SEMANTICS"),
  z.literal("SYSTEM_AGENT_AUTHORITY"),
  z.literal("SUPERVISOR_EXECUTION_SEMANTICS"),
  z.literal("WORKER_MANAGER"),
  z.literal("WORKTREE_MANAGER"),
  z.literal("D4_EXECUTION_SEMANTICS"),
  z.literal("FIRST_AUTO_HARNESS"),
  z.literal("scripts/first-auto-mission.ts"),
  z.literal("APPROVAL_SEMANTICS"),
  z.literal("EXECUTION_GRANT_SEMANTICS"),
]);

export const selfStateOperatingModeSchema = z
  .object({
    LOCAL_DEV_ONLY: z.literal(true),
    CLIENT_SYSTEM_ACCESS: z.literal(false),
    PRODUCTION_ACCESS: z.literal(false),
    CLIENT_CREDENTIALS: z.literal("forbidden"),
    EXTERNAL_IRREVERSIBLE_ACTIONS: z.literal("forbidden"),
  })
  .strict();

const preferencePair = <TPrefer extends string, TOver extends string>(
  prefer: TPrefer,
  over: TOver,
) =>
  z
    .object({
      prefer: z.literal(prefer),
      over: z.literal(over),
    })
    .strict();

export const selfStatePrioritiesSchema = z.tuple([
  preferencePair("FINISH", "NEW FEATURES"),
  preferencePair("INTEGRATION", "EXPLORATION"),
  preferencePair("E2E", "OPTIONAL ARCHITECTURE"),
  preferencePair("TESTABLE PRODUCT", "PERFECT FUTURE PRODUCT"),
]);

export const selfStateGateSummarySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("UNKNOWN") }).strict(),
  z
    .object({
      status: z.literal("PASS"),
      evidence: z.array(sourceIdSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      status: z.literal("FAIL"),
      evidence: z.array(sourceIdSchema).min(1).max(8),
    })
    .strict(),
]);

const candidateImprovementAreaSchema = z
  .object({
    id: selfStateIdSchema,
    description: z.string().min(1).max(500),
    milestoneRelevance: selfStateIdSchema.optional(),
    riskClassification: z.enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]),
    provenance: z.array(sourceIdSchema).min(1).max(8),
  })
  .strict();

const fieldProvenanceSchema = z.array(sourceIdSchema).min(1).max(8);

const selfStateProvenanceSchema = z
  .object({
    sources: z.array(selfStateSourceSchema).min(1).max(32),
    fields: z
      .object({
        schemaVersion: fieldProvenanceSchema,
        currentMilestone: fieldProvenanceSchema,
        completedMilestones: fieldProvenanceSchema,
        incompleteMilestones: fieldProvenanceSchema,
        knownBlockers: fieldProvenanceSchema,
        capabilityReference: fieldProvenanceSchema,
        protectedAreas: fieldProvenanceSchema,
        operatingMode: fieldProvenanceSchema,
        priorities: fieldProvenanceSchema,
        gateSummary: fieldProvenanceSchema,
        candidateImprovementAreas: fieldProvenanceSchema,
        provenance: fieldProvenanceSchema,
      })
      .strict(),
  })
  .strict();

export const selfStateSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    currentMilestone: currentMilestoneSchema,
    completedMilestones: z.array(milestoneSchema).max(100),
    incompleteMilestones: z.array(milestoneSchema).min(1).max(100),
    knownBlockers: z.array(blockerSchema).max(25),
    capabilityReference: capabilityReferenceSchema.default({ status: "UNKNOWN" }),
    protectedAreas: protectedAreasSchema,
    operatingMode: selfStateOperatingModeSchema,
    priorities: selfStatePrioritiesSchema,
    gateSummary: selfStateGateSummarySchema,
    candidateImprovementAreas: z.array(candidateImprovementAreaSchema).max(25),
    provenance: selfStateProvenanceSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const sourceIds = snapshot.provenance.sources.map((source) => source.id);
    const knownSourceIds = new Set(sourceIds);

    if (knownSourceIds.size !== sourceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "sources"],
        message: "provenance source ids must be unique",
      });
    }

    const referencedSourceIds = [
      ...Object.values(snapshot.provenance.fields).flat(),
      ...snapshot.knownBlockers.flatMap((blocker) => blocker.provenance),
      ...snapshot.candidateImprovementAreas.flatMap((candidate) => candidate.provenance),
      ...(snapshot.capabilityReference.source === undefined
        ? []
        : [snapshot.capabilityReference.source]),
      ...("evidence" in snapshot.gateSummary ? snapshot.gateSummary.evidence : []),
    ];

    for (const sourceId of referencedSourceIds) {
      if (!knownSourceIds.has(sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["provenance"],
          message: `unknown provenance source: ${sourceId}`,
        });
      }
    }

    const completedIds = new Set(snapshot.completedMilestones.map((milestone) => milestone.id));
    const incompleteIds = snapshot.incompleteMilestones.map((milestone) => milestone.id);

    if (completedIds.has(snapshot.currentMilestone.id)) {
      context.addIssue({
        code: "custom",
        path: ["currentMilestone"],
        message: "current milestone cannot be completed",
      });
    }

    if (!incompleteIds.includes(snapshot.currentMilestone.id)) {
      context.addIssue({
        code: "custom",
        path: ["incompleteMilestones"],
        message: "current milestone must be listed as incomplete",
      });
    }

    if (incompleteIds.some((id) => completedIds.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["incompleteMilestones"],
        message: "a milestone cannot be both completed and incomplete",
      });
    }
  });

type MutableSelfStateSnapshot = z.infer<typeof selfStateSnapshotSchema>;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

export type SelfStateSnapshot = DeepReadonly<MutableSelfStateSnapshot>;
