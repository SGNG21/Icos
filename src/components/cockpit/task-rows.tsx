import Link from "next/link";

import type { TaskProjection } from "@/features/cockpit/projection";
import { taskStatusPresentation } from "@/features/cockpit/status-presentation";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function StatusBadge({ status }: { status: TaskProjection["task"]["status"] }) {
  const presentation = taskStatusPresentation[status];
  return (
    <span className={`ck-status ck-status--${presentation.tone}`} title={presentation.hint}>
      {presentation.label}
    </span>
  );
}

export interface TaskRowsProps {
  projections: readonly TaskProjection[];
  /** Message affiché lorsqu'il n'y a réellement rien à montrer. */
  emptyLabel: string;
  variant?: "active" | "history";
}

/**
 * Liste dense de tâches, orientée opérations. Chaque ligne mène au détail.
 * Aucun identifiant technique (workflowId) n'est exposé ici : il relève du
 * diagnostic, disponible dans la vue détail.
 */
export function TaskRows({ projections, emptyLabel, variant = "active" }: TaskRowsProps) {
  if (projections.length === 0) {
    return <p className="ck-empty">{emptyLabel}</p>;
  }

  return (
    <ul className={`ck-rows ck-rows--${variant}`}>
      {projections.map(({ task, agentName, summary }) => (
        <li key={task.id} className="ck-row">
          <StatusBadge status={task.status} />
          <div className="ck-row__main">
            <Link className="ck-row__title" href={`/tasks/${task.id}`}>
              {task.title}
            </Link>
            {summary && <p className="ck-row__summary">{summary}</p>}
          </div>
          <div className="ck-row__meta">
            <span>{agentName ?? "Non assigné"}</span>
            <time dateTime={task.updatedAt}>{formatTime(task.updatedAt)}</time>
          </div>
        </li>
      ))}
    </ul>
  );
}
