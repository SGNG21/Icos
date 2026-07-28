import { CkComposer } from "@/components/cockpit/CkComposer";
import { CkInFlowCard } from "@/components/cockpit/CkInFlowCard";
import { CkShell } from "@/components/cockpit/CkShell";
import { CkSidebar } from "@/components/cockpit/CkSidebar";
import type { CapabilityViewSnapshot, CockpitSupervisorSnapshot } from "@/features/cockpit/clients";

export interface CkSupervisorSurfaceProps {
  snapshot: CockpitSupervisorSnapshot;
  capabilities: readonly CapabilityViewSnapshot[];
  dataLabel: string;
  onSubmitObjective: (objective: string) => void | Promise<void>;
  submitError?: string;
}

const capabilityLabel = {
  ALLOWED: "ALLOWED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED — approbation externe requise",
  DENIED: "DENIED — refusé",
  UNAVAILABLE: "UNAVAILABLE — indisponible",
} as const;

export function CkSupervisorSurface({
  snapshot,
  capabilities,
  dataLabel,
  onSubmitObjective,
  submitError,
}: CkSupervisorSurfaceProps) {
  const supervision = (
    <div className="ck-supervision">
      <section className="ck-mission-header" aria-labelledby="mission-title">
        <div>
          <p className="ck-supervision-eyebrow">Mission {snapshot.missionId}</p>
          <h1 id="mission-title">{snapshot.objective}</h1>
        </div>
        <span className="ck-state-badge">{snapshot.missionState}</span>
      </section>

      <div className="ck-local-label" role="status">
        {dataLabel}
      </div>

      <CkInFlowCard title="Plan et dépendances" icon="◇" variant="mission">
        {snapshot.planLabel ? <p className="ck-card-intro">{snapshot.planLabel}</p> : null}
        {snapshot.tasks.length > 0 ? (
          <ol className="ck-supervision-list">
            {snapshot.tasks.map((task) => (
              <li key={task.taskId}>
                <div>
                  <strong>{task.label}</strong>
                  <small>{task.taskId}</small>
                </div>
                <span className="ck-item-status">{task.status}</span>
                <span>
                  Dépend de : {task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "aucune"}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ck-empty-copy">Aucune tâche déclarée.</p>
        )}
      </CkInFlowCard>

      <div className="ck-supervision-grid">
        <CkInFlowCard title="Workers" icon="◉" variant="activity">
          {snapshot.workers.length > 0 ? (
            <ul className="ck-supervision-list">
              {snapshot.workers.map((worker) => (
                <li key={worker.workerId}>
                  <div>
                    <strong>{worker.label}</strong>
                    <small>{worker.workerId}</small>
                  </div>
                  <span className="ck-item-status">{worker.status}</span>
                  <span>
                    Tâches : {worker.taskIds.length > 0 ? worker.taskIds.join(", ") : "aucune"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ck-empty-copy">Aucun worker associé.</p>
          )}
        </CkInFlowCard>

        <CkInFlowCard title="Capacités et permissions" icon="⌁" variant="approval">
          <p className="ck-read-only-note">
            Présentation en lecture seule. UI ≠ permission, approbation ou autorité.
          </p>
          <ul className="ck-capability-list">
            {capabilities.map((capability) => (
              <li key={capability.capabilityId}>
                <div>
                  <strong>{capability.capabilityId}</strong>
                  <span
                    className={`ck-permission-state ck-permission-${capability.permissionState.toLowerCase()}`}
                  >
                    {capabilityLabel[capability.permissionState]}
                  </span>
                </div>
                <p>{capability.reason}</p>
                <small>
                  Portée : {capability.scope} · Disponible : {capability.available ? "oui" : "non"}
                </small>
                {capability.constraints.length > 0 ? (
                  <small>Contraintes : {capability.constraints.join(" · ")}</small>
                ) : null}
              </li>
            ))}
          </ul>
        </CkInFlowCard>
      </div>

      <div className="ck-supervision-grid">
        <CkInFlowCard title="Blocages et erreurs" icon="!" variant="activity">
          <h2>Blocages</h2>
          {snapshot.blockers.length > 0 ? (
            <ul>
              {snapshot.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : (
            <p>Aucun blocage déclaré.</p>
          )}
          <h2>Erreurs</h2>
          {snapshot.errors.length > 0 ? (
            <ul>
              {snapshot.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : (
            <p>Aucune erreur déclarée.</p>
          )}
        </CkInFlowCard>

        <CkInFlowCard title="Résultat final" icon="□" variant="result">
          <p>{snapshot.finalResult ?? "Aucun résultat final déclaré."}</p>
          <dl className="ck-authority-outcomes">
            <div>
              <dt>Fusion</dt>
              <dd>{snapshot.mergePerformed ? "merge effectué" : "merge non effectué"}</dd>
            </div>
            <div>
              <dt>Production</dt>
              <dd>
                {snapshot.productionDeploymentPerformed
                  ? "déploiement production effectué"
                  : "déploiement production non effectué"}
              </dd>
            </div>
          </dl>
        </CkInFlowCard>
      </div>

      <section className="ck-mission-entry" aria-labelledby="mission-entry-title">
        <div>
          <h2 id="mission-entry-title">Nouvelle mission locale</h2>
          <p>La valeur exacte du champ est transmise à l’adaptateur.</p>
        </div>
        <CkComposer onSend={onSubmitObjective} />
        <p className="ck-validation-message" aria-live="polite">
          {submitError ?? "Un objectif non vide est requis."}
        </p>
      </section>
    </div>
  );

  return (
    <CkShell
      sidebar={
        <CkSidebar
          projectSelector={<span className="ck-sidebar-item">Cockpit local</span>}
          activeMissionCount={1}
          historyCount={0}
          footer={<span>Supervision en lecture seule</span>}
        />
      }
      conversation={supervision}
      topBarRight={<span className="ck-read-only-pill">Lecture seule</span>}
    />
  );
}
