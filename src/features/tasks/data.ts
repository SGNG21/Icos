export type TaskStatus = "completed" | "pending_approval" | "queued";

export interface DemoTask {
  id: string;
  title: string;
  agentName: string;
  status: TaskStatus;
}

export const demoTasks: readonly DemoTask[] = [
  {
    id: "task-001",
    title: "Diagnostic du socle ICOS",
    agentName: "CTO",
    status: "completed",
  },
  {
    id: "task-002",
    title: "Politique d’approbation",
    agentName: "Contrôle qualité",
    status: "pending_approval",
  },
  {
    id: "task-003",
    title: "Cartographie des intégrations",
    agentName: "Infrastructure",
    status: "queued",
  },
];
