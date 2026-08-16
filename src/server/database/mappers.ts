import {
  agentActionSchema,
  agentCapabilitySchema,
  agentSchema,
  approvalSchema,
  auditEntrySchema,
  capabilitySchema,
  evaluationSchema,
  securityFindingSchema,
  securityScanSchema,
  skillSchema,
  taskSchema,
  type Agent,
  type AgentAction,
  type AgentCapability,
  type Approval,
  type AuditEntry,
  type Capability,
  type Evaluation,
  type SecurityFinding,
  type SecurityScan,
  type Skill,
  type Task,
} from "@/core/contracts";
import {
  executionGrantSchema,
  executionRecordSchema,
  idempotencyEntrySchema,
  type ExecutionGrant,
  type ExecutionRecord,
  type IdempotencyEntry,
} from "@/core/g1";
import { missionContextSchema, type MissionContext } from "@/core/context/contract";

import { RepositoryMappingError } from "./errors";
import type {
  actions,
  agents,
  approvals,
  auditEntries,
  capabilities,
  agentCapabilities,
  executionGrants,
  executionRecords,
  idempotencyEntries,
  missionContexts,
  skills,
  skillSecurityScans,
  skillSecurityFindings,
  skillEvaluations,
  tasks,
} from "./schema";

type AgentRow = typeof agents.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ActionRow = typeof actions.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
type AuditRow = typeof auditEntries.$inferSelect;
type CapabilityRow = typeof capabilities.$inferSelect;
type AgentCapabilityRow = typeof agentCapabilities.$inferSelect;

type AgentInsert = typeof agents.$inferInsert;
type TaskInsert = typeof tasks.$inferInsert;
type ActionInsert = typeof actions.$inferInsert;
type ApprovalInsert = typeof approvals.$inferInsert;
type AuditInsert = typeof auditEntries.$inferInsert;
type CapabilityInsert = typeof capabilities.$inferInsert;
type AgentCapabilityInsert = typeof agentCapabilities.$inferInsert;

const iso = (value: Date): string => value.toISOString();

// --- Lecture : ligne SQL → contrat (validé par Zod) ---

export function rowToAgent(row: AgentRow): Agent {
  const parsed = agentSchema.safeParse({
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    authorizationLevel: row.authorizationLevel,
    description: row.description,
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("agents", parsed.error.message);
  }
  return parsed.data;
}

export function rowToTask(row: TaskRow, actionIds: string[]): Task {
  const parsed = taskSchema.safeParse({
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    assignedAgentId: row.assignedAgentId ?? undefined,
    status: row.status,
    actionIds,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("tasks", parsed.error.message);
  }
  return parsed.data;
}

export function rowToAction(row: ActionRow): AgentAction {
  const parsed = agentActionSchema.safeParse({
    id: row.id,
    initiatedByAgentId: row.initiatedByAgentId,
    kind: row.kind,
    risk: row.risk,
    requiresHumanApproval: row.requiresHumanApproval,
    approvalStatus: row.approvalStatus,
    taskId: row.taskId ?? undefined,
    // Divergence documentée : la colonne `created_at` porte `requestedAt`.
    requestedAt: iso(row.createdAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("actions", parsed.error.message);
  }
  return parsed.data;
}

export function rowToApproval(row: ApprovalRow): Approval {
  const parsed = approvalSchema.safeParse({
    id: row.id,
    actionId: row.actionId,
    decidedBy: row.decidedByLabel,
    decision: row.decision,
    reason: row.reason ?? undefined,
    decidedAt: iso(row.decidedAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("approvals", parsed.error.message);
  }
  return parsed.data;
}

export function rowToAuditEntry(row: AuditRow): AuditEntry {
  const parsed = auditEntrySchema.safeParse({
    id: row.id,
    occurredAt: iso(row.occurredAt),
    eventType: row.eventType,
    actor: { kind: row.actorType, id: row.actorLabel },
    taskId: row.taskId ?? undefined,
    actionId: row.actionId ?? undefined,
    details: row.details,
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("audit_entries", parsed.error.message);
  }
  return parsed.data;
}

// --- Écriture : contrat → ligne SQL ---

export function agentToRow(agent: Agent): AgentInsert {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    authorizationLevel: agent.authorizationLevel,
    description: agent.description,
  };
}

export function taskToRow(task: Task): TaskInsert {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    assignedAgentId: task.assignedAgentId ?? null,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  };
}

export function actionToRow(action: AgentAction): ActionInsert {
  const at = new Date(action.requestedAt);
  return {
    id: action.id,
    initiatedByAgentId: action.initiatedByAgentId,
    taskId: action.taskId ?? null,
    kind: action.kind,
    risk: action.risk,
    requiresHumanApproval: action.requiresHumanApproval,
    approvalStatus: action.approvalStatus,
    createdAt: at,
    updatedAt: at,
  };
}

export function approvalToRow(approval: Approval): ApprovalInsert {
  return {
    id: approval.id,
    actionId: approval.actionId,
    decision: approval.decision,
    decidedByLabel: approval.decidedBy,
    reason: approval.reason ?? null,
    decidedAt: new Date(approval.decidedAt),
  };
}

export function auditToRow(entry: AuditEntry): AuditInsert {
  return {
    id: entry.id,
    eventType: entry.eventType,
    actorType: entry.actor.kind,
    actorLabel: entry.actor.id,
    taskId: entry.taskId ?? null,
    actionId: entry.actionId ?? null,
    details: entry.details,
    occurredAt: new Date(entry.occurredAt),
  };
}

// --- Capabilities ---

export function rowToCapability(row: CapabilityRow): Capability {
  const parsed = capabilitySchema.safeParse({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    category: row.category,
    status: row.status,
    provenance: row.provenance ?? undefined,
    riskHint: row.riskHint ?? undefined,
    sensitivityLevel: row.sensitivityLevel ?? undefined,
    dataCategory: row.dataCategory ?? undefined,
    retentionPolicyRef: row.retentionPolicyRef ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("capabilities", parsed.error.message);
  }
  return parsed.data;
}

export function capabilityToRow(capability: Capability): CapabilityInsert {
  return {
    id: capability.id,
    key: capability.key,
    name: capability.name,
    description: capability.description ?? null,
    category: capability.category,
    status: capability.status,
    provenance: capability.provenance ?? null,
    riskHint: capability.riskHint ?? null,
    sensitivityLevel: capability.sensitivityLevel ?? null,
    dataCategory: capability.dataCategory ?? null,
    retentionPolicyRef: capability.retentionPolicyRef ?? null,
    createdAt: new Date(capability.createdAt),
    updatedAt: new Date(capability.updatedAt),
  };
}

// --- AgentCapabilities ---

export function rowToAgentCapability(row: AgentCapabilityRow): AgentCapability {
  const parsed = agentCapabilitySchema.safeParse({
    id: row.id,
    agentId: row.agentId,
    capabilityId: row.capabilityId,
    assignedAt: iso(row.assignedAt),
    assignedByUserId: row.assignedByUserId,
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("agent_capabilities", parsed.error.message);
  }
  return parsed.data;
}

export function agentCapabilityToRow(ac: AgentCapability): AgentCapabilityInsert {
  return {
    id: ac.id,
    agentId: ac.agentId,
    capabilityId: ac.capabilityId,
    assignedAt: new Date(ac.assignedAt),
    assignedByUserId: ac.assignedByUserId,
  };
}

// ─────────────────────────────────────
// Skills (Lot C2)
// ─────────────────────────────────────

type SkillRow = typeof skills.$inferSelect;
type SkillInsert = typeof skills.$inferInsert;
type SkillScanRow = typeof skillSecurityScans.$inferSelect;
type SkillScanInsert = typeof skillSecurityScans.$inferInsert;
type SkillFindingRow = typeof skillSecurityFindings.$inferSelect;
type SkillFindingInsert = typeof skillSecurityFindings.$inferInsert;
type SkillEvalRow = typeof skillEvaluations.$inferSelect;
type SkillEvalInsert = typeof skillEvaluations.$inferInsert;

export function rowToSkill(row: SkillRow): Skill {
  const parsed = skillSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    skillKey: row.skillKey,
    version: row.version,
    name: row.name,
    description: row.description ?? undefined,
    capabilityKeys: row.capabilityKeys as string[],
    category: row.category,
    trustState: row.trustState,
    activationState: row.activationState,
    scripts: row.scripts as Skill["scripts"],
    resources: row.resources as Skill["resources"],
    references: row.references as Skill["references"],
    dependencyDeclarations: row.dependencyDeclarations as Skill["dependencyDeclarations"],
    networkRequirements: row.networkRequirements as Skill["networkRequirements"],
    credentialRequirements: row.credentialRequirements as Skill["credentialRequirements"],
    executionIsolationRequirement:
      row.executionIsolationRequirement as Skill["executionIsolationRequirement"],
    toolRequirements: row.toolRequirements as Skill["toolRequirements"],
    inputSchema: row.inputSchema as Record<string, unknown> | undefined,
    outputSchema: row.outputSchema as Record<string, unknown> | undefined,
    dataCategory: row.dataCategory as Skill["dataCategory"],
    sensitivityLevel: row.sensitivityLevel as Skill["sensitivityLevel"],
    contentHash: row.contentHash,
    provenance: row.provenance as Record<string, unknown>,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("skills", parsed.error.message);
  }
  return parsed.data;
}

export function skillToRow(skill: Skill): SkillInsert {
  return {
    id: skill.id,
    tenantId: skill.tenantId,
    skillKey: skill.skillKey,
    version: skill.version,
    name: skill.name,
    description: skill.description ?? null,
    capabilityKeys: skill.capabilityKeys,
    category: skill.category,
    trustState: skill.trustState,
    activationState: skill.activationState,
    scripts: skill.scripts ?? null,
    resources: skill.resources ?? null,
    references: skill.references ?? null,
    dependencyDeclarations: skill.dependencyDeclarations ?? null,
    networkRequirements: skill.networkRequirements ?? null,
    credentialRequirements: skill.credentialRequirements ?? null,
    executionIsolationRequirement: skill.executionIsolationRequirement ?? null,
    toolRequirements: skill.toolRequirements ?? null,
    inputSchema: skill.inputSchema ?? null,
    outputSchema: skill.outputSchema ?? null,
    dataCategory: skill.dataCategory ?? null,
    sensitivityLevel: skill.sensitivityLevel ?? null,
    contentHash: skill.contentHash,
    provenance: skill.provenance as Record<string, unknown>,
    createdAt: new Date(skill.createdAt),
    updatedAt: new Date(skill.updatedAt),
  };
}

export function rowToSecurityScan(row: SkillScanRow): SecurityScan {
  const parsed = securityScanSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    skillId: row.skillId,
    evaluatedContentHash: row.evaluatedContentHash,
    scannerId: row.scannerId,
    scannerVersion: row.scannerVersion ?? undefined,
    status: row.status,
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    createdAt: iso(row.createdAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("skill_security_scans", parsed.error.message);
  }
  return parsed.data;
}

export function securityScanToRow(scan: SecurityScan): SkillScanInsert {
  return {
    id: scan.id,
    tenantId: scan.tenantId,
    skillId: scan.skillId,
    evaluatedContentHash: scan.evaluatedContentHash,
    scannerId: scan.scannerId,
    scannerVersion: scan.scannerVersion ?? null,
    status: scan.status,
    startedAt: new Date(scan.startedAt),
    completedAt: scan.completedAt ? new Date(scan.completedAt) : null,
    metadata: scan.metadata ?? null,
    createdAt: new Date(scan.createdAt),
  };
}

export function rowToSecurityFinding(row: SkillFindingRow): SecurityFinding {
  const parsed = securityFindingSchema.safeParse({
    id: row.id,
    scanId: row.scanId,
    severity: row.severity,
    category: row.category,
    code: row.code ?? undefined,
    message: row.message,
    location: row.location ?? undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    createdAt: iso(row.createdAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("skill_security_findings", parsed.error.message);
  }
  return parsed.data;
}

export function securityFindingToRow(finding: SecurityFinding): SkillFindingInsert {
  return {
    id: finding.id,
    scanId: finding.scanId,
    severity: finding.severity,
    category: finding.category,
    code: finding.code ?? null,
    message: finding.message,
    location: finding.location ?? null,
    metadata: finding.metadata ?? null,
    createdAt: new Date(finding.createdAt),
  };
}

export function rowToSkillEval(row: SkillEvalRow): Evaluation {
  const parsed = evaluationSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    skillId: row.skillId,
    evaluatedContentHash: row.evaluatedContentHash,
    evaluatorType: row.evaluatorType,
    evaluatorVersion: row.evaluatorVersion ?? undefined,
    status: row.status,
    score: row.score as Record<string, unknown> | undefined,
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    createdAt: iso(row.createdAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("skill_evaluations", parsed.error.message);
  }
  return parsed.data;
}

export function skillEvalToRow(evalRecord: Evaluation): SkillEvalInsert {
  return {
    id: evalRecord.id,
    tenantId: evalRecord.tenantId,
    skillId: evalRecord.skillId,
    evaluatedContentHash: evalRecord.evaluatedContentHash,
    evaluatorType: evalRecord.evaluatorType,
    evaluatorVersion: evalRecord.evaluatorVersion ?? null,
    status: evalRecord.status,
    score: evalRecord.score ?? null,
    startedAt: new Date(evalRecord.startedAt),
    completedAt: evalRecord.completedAt ? new Date(evalRecord.completedAt) : null,
    metadata: evalRecord.metadata ?? null,
    createdAt: new Date(evalRecord.createdAt),
  };
}

// ─────────────────────────────────────
// G1 — Tool Gateway Foundation
// ─────────────────────────────────────

type ExecutionGrantRow = typeof executionGrants.$inferSelect;
type ExecutionGrantInsert = typeof executionGrants.$inferInsert;
type IdempotencyEntryRow = typeof idempotencyEntries.$inferSelect;
type IdempotencyEntryInsert = typeof idempotencyEntries.$inferInsert;
type ExecutionRecordRow = typeof executionRecords.$inferSelect;
type ExecutionRecordInsert = typeof executionRecords.$inferInsert;

export function rowToExecutionGrant(row: ExecutionGrantRow): ExecutionGrant {
  const parsed = executionGrantSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    principalId: row.principalId,
    missionId: row.missionId,
    runId: row.runId,
    toolId: row.toolId,
    toolDefinitionHash: row.toolDefinitionHash,
    toolVersion: row.toolVersion ?? undefined,
    capability: row.capability,
    operation: row.operation,
    resource: row.resource,
    requestHash: row.requestHash,
    idempotencyKey: row.idempotencyKey,
    policyProvenance: row.policyProvenance as ExecutionGrant["policyProvenance"],
    credentialRequirements: row.credentialRequirements as ExecutionGrant["credentialRequirements"],
    networkRequirements: row.networkRequirements as ExecutionGrant["networkRequirements"],
    isolationRequirements: row.isolationRequirements as ExecutionGrant["isolationRequirements"],
    issuedAt: iso(row.issuedAt),
    expiresAt: iso(row.expiresAt),
    consumedAt: row.consumedAt ? iso(row.consumedAt) : null,
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("execution_grants", parsed.error.message);
  }
  return parsed.data;
}

export function executionGrantToRow(grant: ExecutionGrant): ExecutionGrantInsert {
  return {
    id: grant.id,
    tenantId: grant.tenantId,
    principalId: grant.principalId,
    missionId: grant.missionId,
    runId: grant.runId,
    toolId: grant.toolId,
    toolDefinitionHash: grant.toolDefinitionHash,
    toolVersion: grant.toolVersion ?? null,
    capability: grant.capability,
    operation: grant.operation,
    resource: grant.resource,
    requestHash: grant.requestHash,
    idempotencyKey: grant.idempotencyKey,
    policyProvenance: grant.policyProvenance,
    credentialRequirements: grant.credentialRequirements,
    networkRequirements: grant.networkRequirements,
    isolationRequirements: grant.isolationRequirements,
    issuedAt: new Date(grant.issuedAt),
    expiresAt: new Date(grant.expiresAt),
    consumedAt: grant.consumedAt ? new Date(grant.consumedAt) : null,
  };
}

export function rowToIdempotencyEntry(row: IdempotencyEntryRow): IdempotencyEntry {
  const parsed = idempotencyEntrySchema.safeParse({
    idempotencyKey: row.idempotencyKey,
    state: row.state,
    requestHash: row.requestHash,
    tenantId: row.tenantId,
    principalId: row.principalId,
    missionId: row.missionId,
    runId: row.runId,
    grantId: row.grantId ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    completedAt: row.completedAt ? iso(row.completedAt) : undefined,
    replayResult: row.replayResult as Record<string, unknown> | undefined,
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("idempotency_entries", parsed.error.message);
  }
  return parsed.data;
}

export function idempotencyEntryToRow(entry: IdempotencyEntry): IdempotencyEntryInsert {
  return {
    idempotencyKey: entry.idempotencyKey,
    state: entry.state,
    requestHash: entry.requestHash,
    tenantId: entry.tenantId,
    principalId: entry.principalId,
    missionId: entry.missionId,
    runId: entry.runId,
    grantId: entry.grantId ?? null,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    completedAt: entry.completedAt ? new Date(entry.completedAt) : null,
    replayResult: entry.replayResult ?? null,
  };
}

export function rowToExecutionRecord(row: ExecutionRecordRow): ExecutionRecord {
  const parsed = executionRecordSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    missionId: row.missionId,
    runId: row.runId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    grantId: row.grantId ?? undefined,
    principalId: row.principalId,
    sensitivityLevel: row.sensitivityLevel,
    events: row.events,
    outputHash: row.outputHash ?? undefined,
    artifactRefs: row.artifactRefs as string[],
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    durationMs: row.durationMs,
    usage: row.usage as ExecutionRecord["usage"],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) {
    throw new RepositoryMappingError("execution_records", parsed.error.message);
  }
  return parsed.data;
}

export function executionRecordToRow(record: ExecutionRecord): ExecutionRecordInsert {
  return {
    id: record.id,
    tenantId: record.tenantId,
    missionId: record.missionId,
    runId: record.runId,
    idempotencyKey: record.idempotencyKey,
    requestHash: record.requestHash,
    grantId: record.grantId ?? null,
    principalId: record.principalId,
    sensitivityLevel: record.sensitivityLevel,
    events: record.events,
    outputHash: record.outputHash ?? null,
    artifactRefs: record.artifactRefs,
    errorCode: record.errorCode ?? null,
    errorMessage: record.errorMessage ?? null,
    durationMs: record.durationMs,
    usage: record.usage ?? null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

// ─────────────────────────────────────
// CTX-SUP-1B — MissionContext
// ─────────────────────────────────────

type MissionContextRow = typeof missionContexts.$inferSelect;
type MissionContextInsert = typeof missionContexts.$inferInsert;

/**
 * Ligne SQL → MissionContext (validé par Zod `.strict()`, fail-closed).
 *
 * Le payload jsonb est la source du contrat, mais les colonnes indexées
 * `(tenant_id, mission_id, version)` sont recroisées avec le payload : toute
 * divergence signale une corruption/altération et lève `RepositoryMappingError`
 * plutôt que de retourner un contexte incohérent (jamais de retour silencieux).
 */
export function rowToMissionContext(row: MissionContextRow): MissionContext {
  const parsed = missionContextSchema.safeParse(row.payload);
  if (!parsed.success) {
    throw new RepositoryMappingError("mission_contexts", parsed.error.message);
  }
  const context = parsed.data;
  if (
    context.tenantId !== row.tenantId ||
    context.missionId !== row.missionId ||
    context.version !== row.version
  ) {
    throw new RepositoryMappingError(
      "mission_contexts",
      "clé de ligne incohérente avec le payload",
    );
  }
  return context;
}

/**
 * MissionContext → ligne SQL. Les colonnes de clé/fraîcheur sont dérivées du
 * contexte lui-même ; `createdAt` est l'instant de persistance (fourni par
 * l'appelant pour rester déterministe et testable).
 */
export function missionContextToRow(
  context: MissionContext,
  createdAt: Date,
): MissionContextInsert {
  return {
    tenantId: context.tenantId,
    missionId: context.missionId,
    version: context.version,
    payload: context,
    builtAt: new Date(context.builtAt),
    createdAt,
  };
}
