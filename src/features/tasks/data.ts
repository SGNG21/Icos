import type { Task } from "@/core/contracts";

export const demoTasks = [
  {
    id: "task-001",
    title: "Diagnostic du socle ICOS",
    assignedAgentId: "agent-cto",
    status: "succeeded",
    actionIds: [],
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-20T17:30:00.000Z",
  },
  {
    id: "task-002",
    title: "Politique d’approbation",
    assignedAgentId: "agent-quality",
    status: "awaiting_approval",
    actionIds: ["action-001", "action-003"],
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:15:00.000Z",
  },
  {
    id: "task-003",
    title: "Cartographie des intégrations",
    assignedAgentId: "agent-infra",
    status: "queued",
    actionIds: ["action-002"],
    createdAt: "2026-07-21T08:05:00.000Z",
    updatedAt: "2026-07-21T08:05:00.000Z",
  },
] satisfies readonly Task[];
