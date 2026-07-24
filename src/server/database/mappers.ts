import {
  agentActionSchema,
  agentCapabilitySchema,
  agentSchema,
  approvalSchema,
  auditEntrySchema,
  capabilitySchema,
  taskSchema,
  type Agent,
  type AgentAction,
  type AgentCapability,
  type Approval,
  type AuditEntry,
  type Capability,
  type Task,
} from "@/core/contracts";

import { RepositoryMappingError } from "./errors";
import type {
  actions,
  agents,
  approvals,
  auditEntries,
  capabilities,
  agentCapabilities,
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
