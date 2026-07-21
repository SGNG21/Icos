import type { TaskStatus } from "@/core/contracts";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

const taskStatusLabel: Record<TaskStatus, string> = {
  draft: "Brouillon",
  queued: "Planifié",
  awaiting_approval: "À approuver",
  running: "En cours",
  succeeded: "Terminé",
  failed: "Échoué",
  cancelled: "Annulé",
};

// Réutilise les classes CSS existantes de globals.css (inchangé pendant ce lot).
const taskIndicatorClass: Record<TaskStatus, string> = {
  draft: "",
  queued: "",
  awaiting_approval: "pending_approval",
  running: "",
  succeeded: "completed",
  failed: "",
  cancelled: "",
};

function agentName(agentId: string | undefined): string {
  if (!agentId) {
    return "Non assigné";
  }
  return demoAgents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

export function RecentTasks() {
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
        {demoTasks.map((task) => (
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
