import type { Agent, Task, TaskStatus } from "@/core/contracts";

const taskStatusLabel: Record<TaskStatus, string> = {
  draft: "Brouillon",
  queued: "Planifié",
  awaiting_approval: "À approuver",
  running: "En cours",
  succeeded: "Terminé",
  failed: "Échoué",
  cancelled: "Annulé",
};

// Réutilise les classes CSS existantes de globals.css.
const taskIndicatorClass: Record<TaskStatus, string> = {
  draft: "",
  queued: "",
  awaiting_approval: "pending_approval",
  running: "",
  succeeded: "completed",
  failed: "",
  cancelled: "",
};

export interface RecentTasksProps {
  tasks: readonly Task[];
  agents: readonly Agent[];
}

export function RecentTasks({ tasks, agents }: RecentTasksProps) {
  const agentName = (agentId: string | undefined): string => {
    if (!agentId) {
      return "Non assigné";
    }
    return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  };

  return (
    <section className="panel task-panel" id="tasks">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Activité</p>
          <h2>Tâches récentes</h2>
        </div>
        <span className="badge">Simulation</span>
      </div>
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id}>
            <span className={`task-indicator ${taskIndicatorClass[task.status]}`.trim()} />
            <div>
              <strong>{task.title}</strong>
              <small>{agentName(task.assignedAgentId)}</small>
            </div>
            <span className="task-status">{taskStatusLabel[task.status]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
