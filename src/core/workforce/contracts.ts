import { z } from "zod";

import { capabilityKeySchema } from "@/core/contracts/capability";
import {
  authorizationLevelSchema,
  idSchema,
  isoDateTimeSchema,
  jsonValueSchema,
} from "@/core/contracts/common";

/**
 * DIGITAL WORKFORCE domain (decision 0056). Pure contracts, no I/O.
 *
 * Organisational identity (role, skill, agent) is NEVER bound to a model. Compute is requested
 * through capabilities and difficulty (`ComputeNeed`); OmniRoute / the CapabilityRouter chooses
 * who runs it. Model names may appear only as non-binding `modelHints`.
 *
 * Autonomy reuses the existing `AuthorizationLevel` (0–3, core/contracts/common.ts) and action
 * execution stays with `decideExecution`: there is one autonomy scale in ICOS, not two.
 */

/** Template ids: `CYBER_SECURITY_AUDIT`, `SALES_DIRECTOR`. */
export const templateIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "identifiant de template invalide (MAJUSCULES_SNAKE)");

export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "version semver attendue");

export const agentKindSchema = z.enum([
  "DURABLE_AGENT",
  "EPHEMERAL_SPECIALIST",
  "EXECUTION_WORKER",
]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const skillRiskSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type SkillRisk = z.infer<typeof skillRiskSchema>;

/** Fact provenance. Never present SIMULATED or NOT_CONNECTED state as REAL. */
export const factSourceSchema = z.enum(["REAL", "SIMULATED", "NOT_CONNECTED"]);
export type FactSource = z.infer<typeof factSourceSchema>;

export const actorRefSchema = z
  .object({ kind: z.enum(["human", "agent", "system"]), id: z.string().min(1) })
  .strict();
export type ActorRef = z.infer<typeof actorRefSchema>;

/** What compute a piece of work needs. Capabilities and difficulty — never a model. */
export const computeNeedSchema = z
  .object({
    reasoning: z.enum(["shallow", "standard", "deep"]),
    /** Worker-registry capability keys the executing worker must declare (e.g. `code.review`). */
    workerCapabilities: z.array(capabilityKeySchema).default([]),
    /** Non-binding preference, recorded but never used as identity or as a gate. */
    modelHints: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ComputeNeed = z.infer<typeof computeNeedSchema>;

const ioSchema = z
  .object({ name: z.string().min(1), description: z.string().min(1), required: z.boolean() })
  .strict();

export const skillDefinitionSchema = z
  .object({
    skillId: templateIdSchema,
    name: z.string().min(1),
    version: semverSchema,
    description: z.string().min(1),
    capabilities: z.array(capabilityKeySchema).min(1),
    inputs: z.array(ioSchema).default([]),
    outputs: z.array(ioSchema).default([]),
    /** Tool ids the skill needs. A NEED, never a grant. */
    requiredTools: z.array(z.string().min(1)).default([]),
    risk: skillRiskSchema,
    /** Permission needs (e.g. `repo.read`). Documented, never conferred. */
    requiredPermissions: z.array(z.string().min(1)).default([]),
    /** Action classes that require human approval (e.g. `destructive_remediation`). */
    approvalRequiredFor: z.array(z.string().min(1)).default([]),
    evidenceRequirements: z.array(z.string().min(1)).default([]),
    /** Certification test ids that must pass before a role using this skill is certified. */
    tests: z.array(z.string().min(1)).default([]),
    qualityGates: z.array(z.string().min(1)).default([]),
    compatibleAgentKinds: z.array(agentKindSchema).min(1),
    compute: computeNeedSchema,
    /** C2 executable skill package keys implementing this competence, if any. */
    implementedBy: z.array(z.string().min(1)).default([]),
    status: z.enum(["active", "retired"]).default("active"),
  })
  .strict();
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

export const roleStatusSchema = z.enum(["draft", "certified", "active", "retired"]);
export type RoleStatus = z.infer<typeof roleStatusSchema>;

export const kpiSchema = z
  .object({
    kpiId: z.string().min(1),
    description: z.string().min(1),
    target: z.string().optional(),
  })
  .strict();
export type Kpi = z.infer<typeof kpiSchema>;

/** A role composes skills. It has NO tool field: a role never implies tool access. */
export const agentRoleSchema = z
  .object({
    roleId: templateIdSchema,
    name: z.string().min(1),
    version: semverSchema,
    description: z.string().min(1),
    status: roleStatusSchema,
    agentKinds: z.array(agentKindSchema).min(1),
    skills: z.array(templateIdSchema).min(1),
    responsibilities: z.array(z.string().min(1)).default([]),
    kpis: z.array(kpiSchema).default([]),
    /** The highest autonomy an agent in this role may ever be GRANTED. Not a grant. */
    autonomyCeiling: authorizationLevelSchema,
    provenance: z
      .object({
        source: z.enum(["bootstrap_template", "dynamic_composition", "human_defined"]),
        createdBy: actorRefSchema,
        need: z.string().optional(),
      })
      .strict(),
    certification: z
      .object({
        certifiedBy: actorRefSchema,
        certifiedAt: isoDateTimeSchema,
        testsPassed: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const departmentSchema = z
  .object({
    departmentId: idSchema,
    name: z.string().min(1),
    parentDepartmentId: idSchema.nullable(),
    supervisorAgentId: idSchema.nullable(),
    purpose: z.string().optional(),
  })
  .strict();
export type Department = z.infer<typeof departmentSchema>;

/** A tool grant ALWAYS originates from a human. `delegatedBy` records a pass-down. */
export const toolGrantSchema = z
  .object({
    toolId: z.string().min(1),
    grantedBy: actorRefSchema.refine(
      (a) => a.kind === "human",
      "un grant d'outil vient d'un humain",
    ),
    delegatedBy: z.string().min(1).optional(),
    grantedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema.optional(),
  })
  .strict();
export type ToolGrant = z.infer<typeof toolGrantSchema>;

export const agentPolicySchema = z
  .object({
    autonomyLevel: authorizationLevelSchema,
    toolGrants: z.array(toolGrantSchema).default([]),
    budget: z
      .object({
        computeUnits: z.number().int().nonnegative(),
        financialCents: z.number().int().nonnegative(),
      })
      .strict(),
    bounds: z
      .object({
        /** Absolute depth (root = 0) below which this agent's subtree may not spawn. */
        maxDepth: z.number().int().nonnegative(),
        /** Active transitive descendants this agent may have at once. */
        maxDescendants: z.number().int().nonnegative(),
        /** Non-terminal assignments this agent may hold at once. */
        maxConcurrentAssignments: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type AgentPolicy = z.infer<typeof agentPolicySchema>;

/** `*` = every client/project of the tenant. Empty = none (fail closed). */
export const workScopeSchema = z
  .object({
    clientIds: z.array(z.string().min(1)).default([]),
    projectIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type WorkScope = z.infer<typeof workScopeSchema>;

/** Memory namespaces; enforcement belongs to the memory layer (lane C). */
export const memoryScopeSchema = z
  .object({
    read: z.array(z.string().min(1)).default([]),
    write: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const agentStatusSchema = z.enum(["active", "suspended", "retired", "blocked"]);
export type WorkforceAgentStatus = z.infer<typeof agentStatusSchema>;
/** No transition leaves these. */
export const TERMINAL_AGENT_STATUSES: readonly WorkforceAgentStatus[] = ["retired", "blocked"];

export const workforceAgentSchema = z
  .object({
    agentId: idSchema,
    tenantId: z.string().min(1),
    kind: agentKindSchema,
    roleId: templateIdSchema,
    roleVersion: semverSchema,
    displayName: z.string().min(1),
    departmentId: idSchema.nullable(),
    /** null only for ICOS Central (the root). */
    supervisorAgentId: idSchema.nullable(),
    /** The agent that spawned this one, if any (spawn lineage). */
    parentAgentId: idSchema.nullable(),
    depth: z.number().int().nonnegative(),
    scope: workScopeSchema,
    memoryScope: memoryScopeSchema,
    policy: agentPolicySchema,
    compute: computeNeedSchema.optional(),
    objectives: z.array(z.string().min(1)).default([]),
    kpis: z.array(kpiSchema).default([]),
    /** Required for EPHEMERAL_SPECIALIST and EXECUTION_WORKER. */
    missionId: z.string().min(1).optional(),
    /** Required for EPHEMERAL_SPECIALIST. */
    expiresAt: isoDateTimeSchema.optional(),
    /** EXECUTION_WORKER only: the worker registry entry it stands for (no second registry). */
    workerId: z.string().min(1).optional(),
    status: agentStatusSchema,
    createdBy: actorRefSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    /** Optimistic concurrency. */
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (a.kind !== "DURABLE_AGENT" && !a.missionId) issue(`${a.kind} requiert missionId`);
    if (a.kind === "EPHEMERAL_SPECIALIST" && !a.expiresAt)
      issue("EPHEMERAL_SPECIALIST requiert expiresAt");
    if (a.kind === "EXECUTION_WORKER" && !a.workerId) issue("EXECUTION_WORKER requiert workerId");
    if (a.supervisorAgentId === null && a.depth !== 0)
      issue("seule la racine n'a pas de superviseur");
    if (a.supervisorAgentId === a.agentId || a.parentAgentId === a.agentId)
      issue("auto-supervision interdite");
  });
export type WorkforceAgent = z.infer<typeof workforceAgentSchema>;

export const assignmentStatusSchema = z.enum([
  "assigned",
  "executing",
  "in_review",
  "changes_requested",
  "accepted",
  "blocked",
  "synthesized",
]);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;
export const TERMINAL_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ["blocked", "synthesized"];

export const reviewOutcomeSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK"]);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

export const workAssignmentSchema = z
  .object({
    assignmentId: idSchema,
    tenantId: z.string().min(1),
    missionId: z.string().min(1),
    taskId: z.string().min(1),
    parentAssignmentId: idSchema.nullable(),
    supervisorAgentId: idSchema,
    assigneeAgentId: idSchema,
    skillId: templateIdSchema,
    requiredCapabilities: z.array(capabilityKeySchema).min(1),
    scope: z.object({ clientId: z.string().optional(), projectId: z.string().optional() }).strict(),
    computeUnits: z.number().int().nonnegative(),
    /** What the assignee was allowed at assignment time (evidence, not authority). */
    permissionsSnapshot: z
      .object({ autonomyLevel: authorizationLevelSchema, toolIds: z.array(z.string()) })
      .strict(),
    status: assignmentStatusSchema,
    /** A required approval blocks execution until a human approves. */
    approval: z
      .object({
        required: z.boolean(),
        reasons: z.array(z.string()),
        approvedBy: actorRefSchema.optional(),
        approvedAt: isoDateTimeSchema.optional(),
      })
      .strict(),
    execution: z
      .object({
        /** Who actually executed. Mandatory: no anonymous work. */
        workerId: z.string().min(1),
        modelKey: z.string().min(1).optional(),
        provider: z.string().min(1).optional(),
        source: factSourceSchema,
        startedAt: isoDateTimeSchema,
        finishedAt: isoDateTimeSchema,
        evidence: z.array(z.string().min(1)).min(1),
        costCents: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        reviewerAgentId: idSchema,
        outcome: reviewOutcomeSchema,
        reviewedAt: isoDateTimeSchema,
        notes: z.string().optional(),
      })
      .strict()
      .optional(),
    correctionCount: z.number().int().nonnegative(),
    synthesis: z
      .object({ summary: z.string().min(1), childAssignmentIds: z.array(idSchema) })
      .strict()
      .optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    version: z.number().int().positive(),
  })
  .strict();
export type WorkAssignment = z.infer<typeof workAssignmentSchema>;

export const performanceObservationSchema = z
  .object({
    observationId: idSchema,
    tenantId: z.string().min(1),
    agentId: idSchema,
    roleId: templateIdSchema,
    skillId: templateIdSchema,
    taskType: z.string().min(1),
    assignmentId: idSchema,
    success: z.boolean(),
    reviewOutcome: reviewOutcomeSchema,
    correctionCount: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative().optional(),
    costCents: z.number().int().nonnegative().optional(),
    failureClass: z.string().min(1).optional(),
    quality: z.number().min(0).max(1).optional(),
    businessOutcome: z.string().min(1).optional(),
    modelKey: z.string().min(1).optional(),
    source: factSourceSchema,
    observedAt: isoDateTimeSchema,
  })
  .strict();
export type PerformanceObservation = z.infer<typeof performanceObservationSchema>;

export const WORKFORCE_EVENT_TYPES = [
  "skill.registered",
  "role.registered",
  "role.certified",
  "role.activated",
  "department.created",
  "agent.created",
  "agent.spawned",
  "agent.policy_changed",
  "agent.status_changed",
  "assignment.created",
  "assignment.approved",
  "assignment.started",
  "assignment.executed",
  "assignment.reviewed",
  "assignment.synthesized",
  "observation.recorded",
  "governance.denied",
] as const;
export const workforceEventTypeSchema = z.enum(WORKFORCE_EVENT_TYPES);

export const workforceEventSchema = z
  .object({
    eventId: idSchema,
    tenantId: z.string().min(1),
    type: workforceEventTypeSchema,
    actor: actorRefSchema,
    subjectId: z.string().min(1),
    details: z.record(z.string(), jsonValueSchema),
    occurredAt: isoDateTimeSchema,
  })
  .strict();
export type WorkforceEvent = z.infer<typeof workforceEventSchema>;

/** A task as the workforce sees it when assigning (the mission layer owns the real task). */
export interface WorkRequest {
  missionId: string;
  taskId: string;
  taskType: string;
  requiredCapabilities: readonly string[];
  scope: { clientId?: string; projectId?: string };
  computeUnits: number;
  /** Action class of what the task will do, matched against `approvalRequiredFor`. */
  actionClass?: string;
}
