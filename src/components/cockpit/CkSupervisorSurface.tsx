import { CkComposer } from "@/components/cockpit/CkComposer";
import { CkInFlowCard } from "@/components/cockpit/CkInFlowCard";
import { CkShell } from "@/components/cockpit/CkShell";
import { CkSidebar } from "@/components/cockpit/CkSidebar";
import type { CockpitUiState } from "@/components/cockpit/CkCockpitApp";
import type { CockpitJobProjection, CockpitJobStatus } from "@/features/cockpit/clients";

export interface CkSupervisorSurfaceProps {
  snapshot?: CockpitJobProjection;
  uiState: CockpitUiState;
  error?: string;
  onSubmitObjective: (objective: string) => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}

const statusLabels: Record<CockpitJobStatus, string> = {
  QUEUED: "En file d’attente",
  RUNNING: "En cours",
  SUCCEEDED: "Réussie",
  FAILED: "Échouée",
  BLOCKED: "Bloquée",
};

const uiStateLabels: Record<CockpitUiState, string> = {
  idle: "Aucune mission en cours",
  submitting: "Envoi de la mission",
  polling: "Mise à jour de la mission",
  succeeded: "Mission réussie",
  failed: "Mission échouée",
  blocked: "Mission bloquée",
  "network-error": "Erreur de communication",
};

export function CkSupervisorSurface({
  snapshot,
  uiState,
  error,
  onSubmitObjective,
  onRetry,
}: CkSupervisorSurfaceProps) {
  const busy = uiState === "submitting" || uiState === "polling";
  const terminal =
    snapshot?.status === "SUCCEEDED" ||
    snapshot?.status === "FAILED" ||
    snapshot?.status === "BLOCKED";

  const supervision = (
    <div className="ck-supervision">
      <section className="ck-mission-header" aria-labelledby="cockpit-title">
        <div>
          <p className="ck-supervision-eyebrow">Supervision locale</p>
          <h1 id="cockpit-title">{snapshot?.objective ?? "Cockpit"}</h1>
        </div>
        {snapshot ? (
          <span className={`ck-state-badge ck-job-${snapshot.status.toLowerCase()}`}>
            {statusLabels[snapshot.status]}
          </span>
        ) : null}
      </section>

      <p className="ck-local-label" role="status" aria-live="polite" aria-atomic="true">
        {snapshot
          ? `${uiStateLabels[uiState]} — statut ${statusLabels[snapshot.status]}`
          : uiStateLabels[uiState]}
      </p>

      {error ? (
        <div className="ck-validation-message" role="alert">
          <p>{error}</p>
          {uiState === "network-error" ? (
            <button type="button" onClick={onRetry}>
              Réessayer la lecture
            </button>
          ) : null}
        </div>
      ) : null}

      {snapshot ? (
        <>
          <CkInFlowCard title="État de la mission" icon="◇" variant="mission">
            <dl className="ck-authority-outcomes">
              <div>
                <dt>Statut du job</dt>
                <dd>{statusLabels[snapshot.status]}</dd>
              </div>
              {snapshot.missionState ? (
                <div>
                  <dt>État Mission</dt>
                  <dd>{snapshot.missionState}</dd>
                </div>
              ) : null}
            </dl>
            {snapshot.planLabel ? <p className="ck-card-intro">{snapshot.planLabel}</p> : null}
          </CkInFlowCard>

          <div className="ck-supervision-grid">
            <CkInFlowCard title="Tâches" icon="◇" variant="mission">
              {snapshot.tasks.length > 0 ? (
                <ol className="ck-supervision-list">
                  {snapshot.tasks.map((task) => (
                    <li key={task.taskId}>
                      <strong>{task.label}</strong>
                      <span className="ck-item-status">{statusLabels[task.status]}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="ck-empty-copy">Aucune tâche déclarée.</p>
              )}
            </CkInFlowCard>

            <CkInFlowCard title="Workers" icon="◉" variant="activity">
              {snapshot.workers.length > 0 ? (
                <ul className="ck-supervision-list">
                  {snapshot.workers.map((worker, index) => (
                    <li key={`${index}-${worker}`}>{worker}</li>
                  ))}
                </ul>
              ) : (
                <p className="ck-empty-copy">Aucun worker déclaré.</p>
              )}
            </CkInFlowCard>
          </div>

          <div className="ck-supervision-grid">
            <CkInFlowCard title="Blocages et erreur" icon="!" variant="activity">
              <h2>Blocages</h2>
              {snapshot.blockers.length > 0 ? (
                <ul>
                  {snapshot.blockers.map((blocker, index) => (
                    <li key={`${index}-${blocker}`}>{blocker}</li>
                  ))}
                </ul>
              ) : (
                <p>Aucun blocage déclaré.</p>
              )}
              <h2>Erreur assainie</h2>
              {snapshot.sanitizedError ? (
                <p role="alert">
                  {snapshot.sanitizedError.code} — {snapshot.sanitizedError.message}
                </p>
              ) : (
                <p>Aucune erreur déclarée.</p>
              )}
            </CkInFlowCard>

            <CkInFlowCard title="Résultat final" icon="□" variant="result">
              <p>
                {terminal
                  ? (snapshot.finalResult ?? "Aucun résultat final déclaré.")
                  : "La mission n’est pas terminée."}
              </p>
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
        </>
      ) : (
        <section aria-labelledby="empty-cockpit-title">
          <h2 id="empty-cockpit-title">Aucune mission</h2>
          <p>Saisissez un objectif pour démarrer une mission locale.</p>
        </section>
      )}

      <section className="ck-mission-entry" aria-labelledby="mission-entry-title">
        <div>
          <h2 id="mission-entry-title">Nouvelle mission locale</h2>
          <p>L’objectif est transmis exactement comme saisi.</p>
        </div>
        <CkComposer onSend={onSubmitObjective} disabled={busy} />
        <p className="ck-validation-message" aria-live="polite">
          {busy ? "Le compositeur est désactivé pendant le traitement." : "Objectif requis."}
        </p>
      </section>
    </div>
  );

  return (
    <CkShell
      sidebar={
        <CkSidebar
          projectSelector={<span className="ck-sidebar-item">Cockpit local</span>}
          activeMissionCount={snapshot && !terminal ? 1 : 0}
          historyCount={terminal ? 1 : 0}
          footer={<span>API locale · autorité inchangée</span>}
        />
      }
      conversation={supervision}
      topBarRight={<span className="ck-read-only-pill">Supervision</span>}
    />
  );
}
