import type { AgentAction } from "@/core/contracts";

/**
 * Actions de démonstration en attente de décision humaine. Les liens vers les
 * tâches sont cohérents avec `demoTasks` (voir la validation d'intégrité
 * référentielle au démarrage du container).
 */
export const demoActions = [
  {
    id: "action-001",
    initiatedByAgentId: "agent-development",
    kind: "repository.push",
    risk: "sensitive",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    taskId: "task-002",
    requestedAt: "2026-07-21T08:10:00.000Z",
  },
  {
    id: "action-002",
    initiatedByAgentId: "agent-infra",
    kind: "integration.map",
    risk: "reversible",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    taskId: "task-003",
    requestedAt: "2026-07-21T08:12:00.000Z",
  },
  {
    id: "action-003",
    initiatedByAgentId: "agent-quality",
    kind: "policy.publish",
    risk: "sensitive",
    requiresHumanApproval: false,
    approvalStatus: "pending",
    taskId: "task-002",
    requestedAt: "2026-07-21T08:14:00.000Z",
  },
] satisfies readonly AgentAction[];
