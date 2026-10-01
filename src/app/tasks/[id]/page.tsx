import Link from "next/link";
import { forbidden, notFound, redirect } from "next/navigation";
import { headers } from "next/headers";

import { StatusBadge } from "@/components/cockpit/task-rows";
import { taskStatusPresentation, workerKindLabel } from "@/features/cockpit/status-presentation";
import { resolveCockpitAccess } from "@/server/auth/cockpit-access";
import { resolveOperationalScope } from "@/server/administration/mission-scope";
import { getContainer } from "@/server/container";
import type { WorkerKind } from "@/core/contracts";

export const dynamic = "force-dynamic";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Vue détail d'une tâche : état métier, worker, résultat/erreur canonique et
 * timeline. Les identifiants techniques (taskId, workflowId) sont relégués dans
 * une section de diagnostic repliée par défaut.
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const container = await getContainer();
  const access = await resolveCockpitAccess(container, await headers());
  if (access.kind === "redirect") {
    redirect("/login");
  }
  if (access.kind === "forbidden") {
    forbidden();
  }

  const { id } = await params;
  // Fail closed via THE canonical resolver: no access service → minimum scope, never global.
  const scope = await resolveOperationalScope(container, access.session);

  const task = await container.tasks.getByIdForScope(id, scope);
  if (!task) {
    notFound();
  }

  const execution = await container.executionResults.getByTaskId(task.id);
  const agent = task.assignedAgentId ? await container.agents.getById(task.assignedAgentId) : null;
  const presentation = taskStatusPresentation[task.status];

  return (
    <main className="ck-detail">
      <nav className="ck-detail__nav">
        <Link href="/">← Cockpit</Link>
      </nav>

      <header className="ck-detail__header">
        <div>
          <p className="eyebrow">Tâche</p>
          <h1>{task.title}</h1>
        </div>
        <StatusBadge status={task.status} />
      </header>

      <p className="ck-detail__hint">{presentation.hint}</p>

      {task.description && (
        <section className="panel">
          <h2>Description</h2>
          <p>{task.description}</p>
        </section>
      )}

      <section className="panel">
        <h2>Affectation</h2>
        <dl className="ck-facts">
          <div>
            <dt>Worker / agent</dt>
            <dd>{agent?.name ?? "Non assigné"}</dd>
          </div>
          <div>
            <dt>Type de worker</dt>
            <dd>
              {execution && execution.workerKind
                ? workerKindLabel[execution.workerKind as keyof typeof workerKindLabel]
                : "—"}
            </dd>
          </div>
        </dl>
      </section>

      {execution?.outcome === "success" && execution.result && (
        <section className="panel">
          <h2>Résultat</h2>
          <pre className="ck-result">{execution.result}</pre>
        </section>
      )}

      {execution?.outcome === "failure" && execution.error && (
        <section className="panel panel--error">
          <h2>Erreur</h2>
          <p className="ck-error-code">{execution.error.code}</p>
          <p>{execution.error.message}</p>
        </section>
      )}

      {!execution && (
        <section className="panel">
          <h2>Résultat</h2>
          <p className="ck-empty">
            Aucun résultat enregistré pour l’instant. Il apparaîtra dès que le worker aura terminé.
          </p>
        </section>
      )}

      <section className="panel">
        <h2>Chronologie</h2>
        <ol className="ck-timeline">
          <li>
            <span>Créée</span>
            <time dateTime={task.createdAt}>{formatDateTime(task.createdAt)}</time>
          </li>
          {execution?.startedAt && (
            <li>
              <span>Démarrée par le worker</span>
              <time dateTime={execution.startedAt}>{formatDateTime(execution.startedAt)}</time>
            </li>
          )}
          {execution && (
            <li>
              <span>{execution.outcome === "success" ? "Terminée" : "Échouée"}</span>
              <time dateTime={execution.completedAt}>{formatDateTime(execution.completedAt)}</time>
            </li>
          )}
          <li>
            <span>Dernière mise à jour</span>
            <time dateTime={task.updatedAt}>{formatDateTime(task.updatedAt)}</time>
          </li>
        </ol>
      </section>

      <details className="ck-diagnostics">
        <summary>Détails techniques</summary>
        <dl className="ck-facts">
          <div>
            <dt>Task ID</dt>
            <dd>
              <code>{task.id}</code>
            </dd>
          </div>
          {execution && (
            <>
              <div>
                <dt>Workflow Temporal</dt>
                <dd>
                  <code>{execution.workflowId}</code>
                </dd>
              </div>
              <div>
                <dt>Enregistré le</dt>
                <dd>{formatDateTime(execution.recordedAt)}</dd>
              </div>
            </>
          )}
        </dl>
      </details>
    </main>
  );
}
