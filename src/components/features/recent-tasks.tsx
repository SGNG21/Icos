import { demoTasks } from "@/features/tasks/data";

const taskStatusLabel = {
  completed: "Terminé",
  pending_approval: "À approuver",
  queued: "Planifié",
} as const;

export function RecentTasks() {
  return (
    <section className="panel task-panel" id="tâches">
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
            <span className={`task-indicator ${task.status}`} />
            <div>
              <strong>{task.title}</strong>
              <small>{task.agentName}</small>
            </div>
            <span className="task-status">{taskStatusLabel[task.status]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
