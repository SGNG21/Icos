"use client";

import { useState } from "react";
import { MobileNav } from "./mobile-nav";
import styles from "./home.module.css";

export interface MobileHomeProps {
  session: {
    user: {
      name?: string;
      email: string;
    };
    roles: string[];
  };
  scope: unknown | null;
}

export function MobileHome({ session, scope }: MobileHomeProps) {
  const [activeNav, setActiveNav] = useState<"home" | "missions" | "voice" | "alerts" | "profile">(
    "home",
  );
  const [commandMode, setCommandMode] = useState<"voice" | "text">("voice");
  const [textCommand, setTextCommand] = useState("");

  const userName = session.user.name || "Geoffrey";
  const greeting = `Bonjour ${userName}`;

  // Future data ports - typed for when backends are integrated
  type MissionStatus = "planning" | "running" | "blocked" | "completed" | "failed" | "UNKNOWN";
  type ApprovalStatus = "pending" | "approved" | "rejected";
  type IncidentSeverity = "critical" | "warning" | "info";

  interface ActiveMission {
    id: string;
    name: string;
    status: MissionStatus;
    currentStep: string;
    attentionRequired: boolean;
    workersActive: number | "UNKNOWN";
    resultReady: boolean;
  }

  interface ApprovalItem {
    id: string;
    title: string;
    description: string;
    status: ApprovalStatus;
    requestedAt: string;
    requestedBy: string;
  }

  interface IncidentItem {
    id: string;
    title: string;
    severity: IncidentSeverity;
    description: string;
    detectedAt: string;
    missionId?: string;
  }

  interface MissionListItem {
    id: string;
    title: string;
    status: MissionStatus;
    owner: string;
    currentActivity: string;
    attentionState: "none" | "needs_review" | "blocked";
  }

  interface WorkerItem {
    id: string;
    name: string;
    status: "healthy" | "degraded" | "unhealthy" | "UNKNOWN";
    currentTask: string | "IDLE";
    runtime: string;
  }

  interface ProposalItem {
    id: string;
    title: string;
    description: string;
    status: "proposed" | "awaiting_approval" | "approved" | "rejected";
  }

  interface ActivityItem {
    id: string;
    type:
      | "mission_created"
      | "mission_completed"
      | "approval_requested"
      | "worker_started"
      | "result_available"
      | "incident_detected";
    title: string;
    description: string;
    timestamp: string;
    missionId?: string;
  }

  // These will be replaced with real data from backends when integrated
  const [activeMission, setActiveMission] = useState<ActiveMission | null>(null); // NOT_CONNECTED
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]); // NOT_CONNECTED
  const [incidents, setIncidents] = useState<IncidentItem[]>([]); // NOT_CONNECTED
  const [missions, setMissions] = useState<MissionListItem[]>([]); // NOT_CONNECTED
  const [workers, setWorkers] = useState<WorkerItem[]>([]); // NOT_CONNECTED
  const [proposals, setProposals] = useState<ProposalItem[]>([]); // NOT_CONNECTED
  const [recentActivity, setRecentActivity] = useState<ActivityItem[]>([]); // NOT_CONNECTED

  const systemHealthy = true; // Will come from health checks
  const voiceConnected = true; // Will come from voice link state

  const handleVoiceCommand = () => {
    setCommandMode("voice");
    // Navigate to voice page
    window.location.href = "/voice";
  };

  const handleTextCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textCommand.trim()) return;
    // Future: send to ICOS command processor
    setTextCommand("");
  };

  const renderConnectionStatus = () => {
    const status = systemHealthy ? "nominal" : "degraded";
    const statusClass = systemHealthy ? "status-ok" : "status-warning";
    return (
      <div className={`${styles.systemStatus} ${styles[statusClass]}`}>
        <span className={styles.statusDot} />
        <span>ICOS {status}</span>
        {voiceConnected && <span className={styles.voiceBadge}>VOIX</span>}
      </div>
    );
  };

  const renderCommandSurface = () => (
    <section className={styles.commandSurface} aria-label="Commande ICOS">
      <div className={styles.commandPrompt}>Que voulez-vous faire ?</div>

      <div className={styles.commandModes}>
        <button
          className={`${styles.commandBtn} ${commandMode === "voice" ? styles.active : ""}`}
          onClick={handleVoiceCommand}
          aria-pressed={commandMode === "voice"}
        >
          <svg
            className={styles.micIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="8" y1="22" x2="16" y2="22" />
          </svg>
          <span>Voix</span>
        </button>

        <form onSubmit={handleTextCommand} className={styles.textCommandForm}>
          <input
            type="text"
            value={textCommand}
            onChange={(e) => setTextCommand(e.target.value)}
            placeholder="Tapez une commande…"
            className={styles.textCommandInput}
            aria-label="Commande textuelle"
          />
          <button type="submit" className={styles.textCommandSubmit} disabled={!textCommand.trim()}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
      </div>
    </section>
  );

  const renderActiveMission = () => {
    if (!activeMission) {
      return (
        <section className={styles.section} aria-labelledby="active-mission-heading">
          <h2 id="active-mission-heading" className={styles.sectionTitle}>
            Mission active
          </h2>
          <div className={styles.notConnected}>
            <p>
              Mission active : <strong>NON CONNECTÉE</strong>
            </p>
            <p className={styles.muted}>Intégration CORE3/Workforce non disponible</p>
          </div>
        </section>
      );
    }

    const mission = activeMission;
    return (
      <section className={styles.section} aria-labelledby="active-mission-heading">
        <h2 id="active-mission-heading" className={styles.sectionTitle}>
          Mission active
        </h2>
        <article className={styles.missionCard}>
          <header className={styles.missionCardHeader}>
            <h3 className={styles.missionCardTitle}>{mission.name}</h3>
            <span className={`${styles.missionCardStatus} ${styles[`status-${mission.status}`]}`}>
              {mission.status}
            </span>
          </header>
          <div className={styles.missionCardMeta}>
            <div className={styles.missionCardField}>
              <span className={styles.missionCardLabel}>Étape actuelle</span>
              <span className={styles.missionCardValue}>{mission.currentStep}</span>
            </div>
            {mission.attentionRequired && (
              <div className={`${styles.missionCardField} ${styles.attention}`}>
                <span className={styles.missionCardLabel}>⚠ Attention requise</span>
                <span className={styles.missionCardValue}>OUI</span>
              </div>
            )}
            <div className={styles.missionCardField}>
              <span className={styles.missionCardLabel}>Workers actifs</span>
              <span className={styles.missionCardValue}>
                {mission.workersActive === "UNKNOWN" ? "NON CONNECTÉ" : mission.workersActive}
              </span>
            </div>
            <div className={styles.missionCardField}>
              <span className={styles.missionCardLabel}>Résultat</span>
              <span className={styles.missionCardValue}>
                {mission.resultReady ? "PRÊT" : "EN COURS"}
              </span>
            </div>
          </div>
        </article>
      </section>
    );
  };

  const renderApprovals = () => {
    if (approvals.length === 0) return null;
    return (
      <section className={styles.section} aria-labelledby="approvals-heading">
        <h2 id="approvals-heading" className={styles.sectionTitle}>
          Approbations
        </h2>
        <div className={styles.approvalsList}>
          {approvals.map((approval) => (
            <article
              key={approval.id}
              className={`${styles.approvalCard} ${styles[`approval-${approval.status}`]}`}
            >
              <div className={styles.approvalContent}>
                <h3 className={styles.approvalTitle}>{approval.title}</h3>
                <p className={styles.approvalDesc}>{approval.description}</p>
                <div className={styles.approvalMeta}>
                  <span>Demandé par {approval.requestedBy}</span>
                  <span>{new Date(approval.requestedAt).toLocaleString("fr-FR")}</span>
                </div>
              </div>
              <div className={styles.approvalActions}>
                <button className={`${styles.approvalBtn} ${styles.approve}`}>Approuver</button>
                <button className={`${styles.approvalBtn} ${styles.reject}`}>Rejeter</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  };

  const renderIncidents = () => {
    if (incidents.length === 0) return null;
    return (
      <section className={styles.section} aria-labelledby="incidents-heading">
        <h2 id="incidents-heading" className={styles.sectionTitle}>
          Incidents / Attention
        </h2>
        <div className={styles.incidentsList}>
          {incidents.map((incident) => (
            <article
              key={incident.id}
              className={`${styles.incidentCard} ${styles[`severity-${incident.severity}`]}`}
            >
              <div className={styles.incidentIcon}>
                {incident.severity === "critical" && (
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 2L2 22h20L12 2Z" />
                    <path d="M12 9v4M12 17h.01" />
                  </svg>
                )}
                {incident.severity === "warning" && (
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Zm-1-15v8h2v-8h-2Zm0 10h2v2h-2v-2Z" />
                  </svg>
                )}
                {incident.severity === "info" && (
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                )}
              </div>
              <div className={styles.incidentContent}>
                <h3 className={styles.incidentTitle}>{incident.title}</h3>
                <p className={styles.incidentDesc}>{incident.description}</p>
                <div className={styles.incidentMeta}>
                  <span>{new Date(incident.detectedAt).toLocaleString("fr-FR")}</span>
                  {incident.missionId && <span>Mission: {incident.missionId}</span>}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  };

  const renderMissions = () => (
    <section className={styles.section} aria-labelledby="missions-heading">
      <h2 id="missions-heading" className={styles.sectionTitle}>
        Missions
      </h2>
      {missions.length > 0 ? (
        <ul className={styles.missionsList}>
          {missions.map((mission) => (
            <li key={mission.id} className={styles.missionItem}>
              <div className={styles.missionItemMain}>
                <h3 className={styles.missionItemTitle}>{mission.title}</h3>
                <span
                  className={`${styles.missionItemStatus} ${styles[`status-${mission.status}`]}`}
                >
                  {mission.status}
                </span>
              </div>
              <div className={styles.missionItemMeta}>
                <span className={styles.missionItemOwner}>{mission.owner}</span>
                <span className={styles.missionItemActivity}>{mission.currentActivity}</span>
              </div>
              {mission.attentionState !== "none" && (
                <span
                  className={`${styles.attentionBadge} ${styles[`attention-${mission.attentionState}`]}`}
                >
                  {mission.attentionState === "needs_review" ? "À revoir" : "Bloquée"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.notConnected}>
          <p>
            Missions : <strong>NON CONNECTÉES</strong>
          </p>
          <p className={styles.muted}>Backend Missions non disponible</p>
        </div>
      )}
    </section>
  );

  const renderWorkers = () => (
    <section className={styles.section} aria-labelledby="workers-heading">
      <h2 id="workers-heading" className={styles.sectionTitle}>
        Workers
      </h2>
      {workers.length > 0 ? (
        <ul className={styles.workersList}>
          {workers.map((worker) => (
            <li key={worker.id} className={styles.workerItem}>
              <div className={styles.workerInfo}>
                <h3 className={styles.workerName}>{worker.name}</h3>
                <span className={styles.workerRuntime}>{worker.runtime}</span>
              </div>
              <div className={styles.workerStatus}>
                <span
                  className={`${styles.workerStatusDot} ${styles[`worker-${worker.status}`]}`}
                />
                <span className={`${styles.workerStatusText} ${styles[`worker-${worker.status}`]}`}>
                  {worker.status === "UNKNOWN" ? "NON CONNECTÉ" : worker.status}
                </span>
              </div>
              <p className={styles.workerTask}>
                {worker.currentTask === "IDLE" ? "Inactif" : worker.currentTask}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.notConnected}>
          <p>
            Workers : <strong>NON CONNECTÉS</strong>
          </p>
          <p className={styles.muted}>Workforce backend non intégré</p>
        </div>
      )}
    </section>
  );

  const renderProposals = () => {
    if (proposals.length === 0) return null;
    return (
      <section className={styles.section} aria-labelledby="proposals-heading">
        <h2 id="proposals-heading" className={styles.sectionTitle}>
          Propositions ICOS
        </h2>
        <div className={styles.proposalsList}>
          {proposals.map((proposal) => (
            <article key={proposal.id} className={styles.proposalCard}>
              <div className={styles.proposalIcon}>💡</div>
              <div className={styles.proposalContent}>
                <h3 className={styles.proposalTitle}>{proposal.title}</h3>
                <p className={styles.proposalDesc}>{proposal.description}</p>
                <span
                  className={`${styles.proposalStatus} ${styles[`proposal-${proposal.status}`]}`}
                >
                  {proposal.status}
                </span>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  };

  const renderRecentActivity = () => (
    <section className={styles.section} aria-labelledby="activity-heading">
      <h2 id="activity-heading" className={styles.sectionTitle}>
        Activité récente
      </h2>
      {recentActivity.length > 0 ? (
        <ul className={styles.activityList}>
          {recentActivity.map((activity) => (
            <li key={activity.id} className={styles.activityItem}>
              <div className={styles.activityIcon}>
                {activity.type === "mission_created" && "➕"}
                {activity.type === "mission_completed" && "✅"}
                {activity.type === "approval_requested" && "📋"}
                {activity.type === "worker_started" && "👷"}
                {activity.type === "result_available" && "📊"}
                {activity.type === "incident_detected" && "🚨"}
              </div>
              <div className={styles.activityContent}>
                <h3 className={styles.activityTitle}>{activity.title}</h3>
                <p className={styles.activityDesc}>{activity.description}</p>
              </div>
              <time className={styles.activityTime} dateTime={activity.timestamp}>
                {new Date(activity.timestamp).toLocaleString("fr-FR")}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.notConnected}>
          <p>
            Activité récente : <strong>NON CONNECTÉE</strong>
          </p>
          <p className={styles.muted}>Superviseur proactif non connecté</p>
        </div>
      )}
    </section>
  );

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.logo}>ICOS</h1>
          {renderConnectionStatus()}
        </div>
        <div className={styles.headerRight}>
          <p className={styles.greeting}>{greeting}</p>
        </div>
      </header>

      <div className={styles.content}>
        {renderCommandSurface()}
        {renderActiveMission()}
        {renderApprovals()}
        {renderIncidents()}
        {renderMissions()}
        {renderWorkers()}
        {renderProposals()}
        {renderRecentActivity()}
      </div>

      <MobileNav active={activeNav} onChange={setActiveNav} />
    </main>
  );
}
