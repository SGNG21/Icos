"use client";

import { useCallback, useState } from "react";

import { isReal, MISSING_LABEL, type Truth } from "@/features/cockpit/truth";
import {
  MISSION_STATUS_CSS,
  MISSION_STATUS_LABEL,
  SECTION_LABEL,
  WORKER_HEALTH_CSS,
  type ActivityRow,
  type MobileHomeModel,
  type Section,
  type WorkerRow,
} from "@/features/mobile/home";

import { CommandBar } from "./command-bar";
import { LiveStatus } from "./live-status";
import { MobileNav } from "./mobile-nav";
import styles from "./home.module.css";

/**
 * ICOS Mobile Home — a READ/CONTROL surface over the canonical runtime.
 *
 * Every value on this screen is a fact the server read from a canonical ICOS source
 * (see `@/features/mobile/load`), or an explicit non-value. The component derives
 * nothing, holds no business rule, and has exactly two write paths, both requiring an
 * explicit gesture from the owner: a conversation turn to the Cognitive Runtime, and a
 * decision on a pending action through the canonical action-decision route. Opening the
 * page mutates nothing.
 */

export interface MobileHomeProps {
  session: {
    user: {
      name?: string;
      email: string;
    };
    roles: string[];
  };
  model: MobileHomeModel;
}

/** Single-tenant ICOS runs on Paris time; fixing it keeps server and client markup identical. */
const DATE_TIME = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Paris",
});
const at = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : DATE_TIME.format(ms);
};

/**
 * Renders a Truth without ever substituting a default for a missing value.
 *
 * The reason is VISIBLE text, not a `title`: this page is read on a phone, where there is
 * no hover, so a tooltip would make every explanation unreachable on the only device that
 * matters. The section-level states already state their reason the same way.
 */
function TruthText({ truth }: { truth: Truth<string | number> }) {
  if (isReal(truth)) return <>{truth.value}</>;
  return (
    <>
      {MISSING_LABEL[truth.kind]}
      <span className={styles.truthReason}>{truth.reason}</span>
    </>
  );
}

/**
 * What a worker is doing. "Aucune tâche dispatchée" is a definite claim, so it is only
 * made when the dispatch ledger was actually read.
 */
function WorkerTask({ truth }: { truth: WorkerRow["currentTask"] }) {
  if (!isReal(truth)) {
    return (
      <>
        Tâche : {MISSING_LABEL[truth.kind]}
        <span className={styles.truthReason}>{truth.reason}</span>
      </>
    );
  }
  if (!truth.value) return <>Aucune tâche dispatchée</>;
  const { taskId, state, others } = truth.value;
  return (
    <>
      {taskId} · {state}
      {others > 0 && ` · +${others} autre${others > 1 ? "s" : ""}`}
    </>
  );
}

/**
 * The honest state of a section that has nothing to render. EMPTY says the source
 * answered with nothing; the other states say the source did not answer.
 */
function SectionState({ section, empty }: { section: Section<unknown>; empty: string }) {
  if (section.state === "EMPTY") {
    return (
      <div className={styles.notConnected}>
        <p className={styles.muted}>{empty}</p>
      </div>
    );
  }
  if (section.state === "CONNECTED" || section.state === "DEGRADED") return null;
  return (
    <div className={styles.notConnected}>
      <p>
        <strong>{SECTION_LABEL[section.state]}</strong>
      </p>
      {section.reason && <p className={styles.muted}>{section.reason}</p>}
      {section.requirement && <p className={styles.muted}>{section.requirement}</p>}
    </div>
  );
}

/**
 * The perimeter the page was read under. An EMPTY mission or approval list is only "there
 * is nothing" within a known scope: `resolveOperationalScope` falls back to an EMPTY linked
 * scope when the operational-access service is not composed, and that must not read as an
 * idle ICOS. Shown as visible text — a phone has no hover.
 */
function ScopeNote({ scope }: { scope: MobileHomeModel["scope"] }) {
  if (scope === "global") return null;
  return (
    <p className={styles.muted}>
      Périmètre <strong>LIÉ</strong> — cette liste ne montre que ce que vos liens d&apos;agent
      autorisent. Une liste vide ne veut pas dire qu&apos;ICOS n&apos;a rien.
    </p>
  );
}

/** A section that rendered real rows but lost one of its supporting sources. */
function DegradedNote({ section }: { section: Section<unknown> }) {
  if (section.state !== "DEGRADED") return null;
  return (
    <p className={styles.muted}>
      <strong>DÉGRADÉE</strong> — {section.reason}
    </p>
  );
}

const ACTIVITY_GLYPH: Record<ActivityRow["tone"], string> = {
  critical: "⨯",
  warn: "!",
  ok: "✓",
  autonomy: "∴",
  flow: "·",
  unknown: "?",
};

export function MobileHome({ session, model }: MobileHomeProps) {
  const [activeNav, setActiveNav] = useState<"home" | "missions" | "voice" | "alerts" | "profile">(
    "home",
  );
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [decided, setDecided] = useState<Record<string, string>>({});
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const userName = session.user.name || session.user.email;
  const decidedByLabel = userName;

  /** Canonical action-decision route; the Mobile Home never writes to a repository itself. */
  const decide = useCallback(
    async (actionId: string, decision: "approved" | "rejected", motive?: string) => {
      setBusyApproval(actionId);
      setApprovalError(null);
      try {
        const res = await fetch(`/api/actions/${actionId}/decision`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decidedByLabel,
            decision,
            ...(motive ? { reason: motive } : {}),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          execution?: { outcome: string };
          error?: { message: string };
        };
        if (!res.ok || !data.execution) {
          setApprovalError(data.error?.message ?? "La décision n'a pas abouti.");
          return;
        }
        setDecided((prev) => ({ ...prev, [actionId]: data.execution!.outcome }));
        setRejecting(null);
        setReason("");
      } catch {
        setApprovalError("La décision n'a pas atteint ICOS.");
      } finally {
        setBusyApproval(null);
      }
    },
    [decidedByLabel],
  );

  const activeMission = model.activeMission.items[0];
  const workforce = model.workforce.items[0];

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.logo}>ICOS</h1>
          <LiveStatus generatedAt={model.generatedAt} health={model.health} />
        </div>
        <div className={styles.headerRight}>
          <p className={styles.greeting}>Bonjour {userName}</p>
        </div>
      </header>

      <div className={styles.content}>
        <section className={styles.commandSurface} aria-label="Commande ICOS">
          <div className={styles.commandPrompt}>Que voulez-vous faire ?</div>
          <div className={styles.commandModes}>
            <a href="/voice" className={styles.commandBtn}>
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
            </a>
            <CommandBar
              canConverse={model.canConverse}
              canDecideProposals={model.canDecideProposals}
            />
          </div>
        </section>

        {/* ── Mission active (CORE3) ───────────────────────────────────────── */}
        <section className={styles.section} aria-labelledby="active-mission-heading">
          <h2 id="active-mission-heading" className={styles.sectionTitle}>
            Mission active
          </h2>
          <SectionState section={model.activeMission} empty="Aucune mission active." />
          {activeMission && (
            <article className={styles.missionCard}>
              <header className={styles.missionCardHeader}>
                <h3 className={styles.missionCardTitle}>{activeMission.title}</h3>
                <span
                  className={`${styles.missionCardStatus} ${styles[`status-${MISSION_STATUS_CSS[activeMission.status]}`]}`}
                >
                  {MISSION_STATUS_LABEL[activeMission.status]}
                </span>
              </header>
              <div className={styles.missionCardMeta}>
                <div className={styles.missionCardField}>
                  <span className={styles.missionCardLabel}>Objectif</span>
                  <span className={styles.missionCardValue}>{activeMission.objective}</span>
                </div>
                <div className={styles.missionCardField}>
                  <span className={styles.missionCardLabel}>Tâche courante</span>
                  <span className={styles.missionCardValue}>
                    <TruthText truth={activeMission.currentTask} />
                  </span>
                </div>
                {activeMission.attention && (
                  <div className={`${styles.missionCardField} ${styles.attention}`}>
                    <span className={styles.missionCardLabel}>⚠ Attention requise</span>
                    <span className={styles.missionCardValue}>OUI</span>
                  </div>
                )}
                <div className={styles.missionCardField}>
                  <span className={styles.missionCardLabel}>Approbation</span>
                  <span className={styles.missionCardValue}>
                    {activeMission.approvalRequired ? "REQUISE" : "AUCUNE"}
                  </span>
                </div>
                <div className={styles.missionCardField}>
                  <span className={styles.missionCardLabel}>Workers actifs</span>
                  <span className={styles.missionCardValue}>
                    <TruthText truth={activeMission.workersActive} />
                  </span>
                </div>
                <div className={styles.missionCardField}>
                  <span className={styles.missionCardLabel}>Progression</span>
                  <span className={styles.missionCardValue}>
                    {activeMission.progress
                      ? `${activeMission.progress.completed}/${activeMission.progress.total} tâches (${activeMission.progress.pct} %)`
                      : "AUCUNE TÂCHE"}
                  </span>
                </div>
                <div className={styles.missionCardField}>
                  <span className={styles.missionCardLabel}>Mise à jour</span>
                  <span className={styles.missionCardValue}>{at(activeMission.updatedAt)}</span>
                </div>
                <div className={styles.missionCardField}>
                  <span className={styles.missionCardLabel}>Mission</span>
                  <span className={styles.missionCardValue}>
                    <code>{activeMission.id}</code>
                  </span>
                </div>
              </div>
              <DegradedNote section={model.activeMission} />
            </article>
          )}
        </section>

        {/* ── Approbations (canonical action repository) ────────────────────── */}
        <section className={styles.section} aria-labelledby="approvals-heading">
          <h2 id="approvals-heading" className={styles.sectionTitle}>
            Approbations
          </h2>
          <SectionState section={model.approvals} empty="Aucune action en attente de décision." />
          <DegradedNote section={model.approvals} />
          <ScopeNote scope={model.scope} />
          {approvalError && (
            <p className={styles.muted} role="alert">
              {approvalError}
            </p>
          )}
          {model.approvals.items.length > 0 && (
            <div className={styles.approvalsList}>
              {model.approvals.items.map((approval) => (
                <article
                  key={approval.id}
                  className={`${styles.approvalCard} ${styles["approval-pending"]}`}
                >
                  <div className={styles.approvalContent}>
                    <h3 className={styles.approvalTitle}>{approval.kind}</h3>
                    <p className={styles.approvalDesc}>
                      Risque : {approval.risk}
                      {approval.taskId ? ` · tâche ${approval.taskId}` : ""}
                    </p>
                    <div className={styles.approvalMeta}>
                      <span>Demandé par {approval.requestedBy}</span>
                      <span>{at(approval.requestedAt)}</span>
                    </div>
                  </div>
                  {decided[approval.id] ? (
                    <p className={styles.muted}>Décision enregistrée : {decided[approval.id]}</p>
                  ) : !model.canDecideApprovals ? (
                    <p className={styles.muted}>
                      Décision réservée au rôle habilité (approvals.decide).
                    </p>
                  ) : rejecting === approval.id ? (
                    <div className={styles.approvalReject}>
                      <input
                        type="text"
                        className={styles.textCommandInput}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Motif du rejet (obligatoire)"
                        aria-label="Motif du rejet"
                      />
                      <button
                        type="button"
                        className={`${styles.approvalBtn} ${styles.reject}`}
                        disabled={busyApproval !== null || reason.trim().length === 0}
                        onClick={() => void decide(approval.id, "rejected", reason.trim())}
                      >
                        Confirmer le rejet
                      </button>
                      <button
                        type="button"
                        className={styles.approvalBtn}
                        onClick={() => {
                          setRejecting(null);
                          setReason("");
                        }}
                      >
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <div className={styles.approvalActions}>
                      <button
                        type="button"
                        className={`${styles.approvalBtn} ${styles.approve}`}
                        disabled={busyApproval !== null}
                        onClick={() => void decide(approval.id, "approved")}
                      >
                        Approuver
                      </button>
                      <button
                        type="button"
                        className={`${styles.approvalBtn} ${styles.reject}`}
                        disabled={busyApproval !== null}
                        onClick={() => setRejecting(approval.id)}
                      >
                        Rejeter
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* ── Incidents (cockpit alerts + Proactive Supervisor situations) ──── */}
        <section className={styles.section} aria-labelledby="incidents-heading">
          <h2 id="incidents-heading" className={styles.sectionTitle}>
            Incidents / Attention
          </h2>
          <SectionState section={model.incidents} empty="Aucun incident ouvert." />
          <DegradedNote section={model.incidents} />
          {model.incidents.items.length > 0 && (
            <div className={styles.incidentsList}>
              {model.incidents.items.map((incident) => (
                <article
                  key={incident.id}
                  className={`${styles.incidentCard} ${styles[`severity-${incident.severity}`]}`}
                >
                  <div className={styles.incidentIcon} aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="12" r="10" />
                    </svg>
                  </div>
                  <div className={styles.incidentContent}>
                    <h3 className={styles.incidentTitle}>{incident.title}</h3>
                    <p className={styles.incidentDesc}>{incident.description}</p>
                    <div className={styles.incidentMeta}>
                      <span>{incident.severityLabel.toUpperCase()}</span>
                      {incident.at && <span>{at(incident.at)}</span>}
                      <span>
                        {incident.source === "supervisor" ? "Superviseur proactif" : "ICOS"}
                      </span>
                      {incident.scope && <span>{incident.scope}</span>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* ── Missions (CORE3 read path, caller's operational scope) ────────── */}
        <section className={styles.section} aria-labelledby="missions-heading">
          <h2 id="missions-heading" className={styles.sectionTitle}>
            Missions
          </h2>
          <SectionState section={model.missions} empty="Aucune mission dans votre périmètre." />
          <DegradedNote section={model.missions} />
          <ScopeNote scope={model.scope} />
          {model.missions.items.length > 0 && (
            <ul className={styles.missionsList}>
              {model.missions.items.map((mission) => (
                <li key={mission.id} className={styles.missionItem}>
                  <div className={styles.missionItemMain}>
                    <h3 className={styles.missionItemTitle}>{mission.title}</h3>
                    <span
                      className={`${styles.missionItemStatus} ${styles[`status-${MISSION_STATUS_CSS[mission.status]}`]}`}
                    >
                      {MISSION_STATUS_LABEL[mission.status]}
                    </span>
                  </div>
                  <div className={styles.missionItemMeta}>
                    <span className={styles.missionItemOwner}>{at(mission.updatedAt)}</span>
                    <span className={styles.missionItemActivity}>
                      {mission.progress
                        ? `${mission.progress.completed}/${mission.progress.total} tâches · ${mission.running} en cours`
                        : "aucune tâche"}
                    </span>
                  </div>
                  {mission.attention !== "none" && (
                    <span
                      className={`${styles.attentionBadge} ${styles[`attention-${mission.attention}`]}`}
                    >
                      {mission.attention === "needs_review" ? "À revoir" : "Bloquée"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Workers (CORE3 worker registry — presence in a catalog is NOT health) ── */}
        <section className={styles.section} aria-labelledby="workers-heading">
          <h2 id="workers-heading" className={styles.sectionTitle}>
            Workers
          </h2>
          <SectionState section={model.workers} empty="Aucun worker enregistré." />
          <DegradedNote section={model.workers} />
          {model.workers.items.length > 0 && (
            <ul className={styles.workersList}>
              {model.workers.items.map((worker) => (
                <li key={worker.id} className={styles.workerItem}>
                  <div className={styles.workerInfo}>
                    <h3 className={styles.workerName}>{worker.name}</h3>
                    <span className={styles.workerRuntime}>{worker.runtime}</span>
                  </div>
                  <div className={styles.workerStatus}>
                    <span
                      className={`${styles.workerStatusDot} ${styles[`worker-${WORKER_HEALTH_CSS[worker.health]}`]}`}
                    />
                    <span
                      className={`${styles.workerStatusText} ${styles[`worker-${WORKER_HEALTH_CSS[worker.health]}`]}`}
                    >
                      {worker.health === "unknown" ? "INCONNU" : worker.health}
                    </span>
                  </div>
                  <p className={styles.workerTask}>
                    <WorkerTask truth={worker.currentTask} />
                  </p>
                  <p className={styles.workerMeta}>
                    <span>
                      modèle <TruthText truth={worker.model} />
                    </span>
                    <span>
                      fournisseur <TruthText truth={worker.provider} />
                    </span>
                    <span>
                      capacité <TruthText truth={worker.slots.used} />/{worker.slots.max}
                    </span>
                    <span>statut {worker.status}</span>
                    <span>disponibilité {worker.availability}</span>
                    <span>sonde {worker.probeOutcome}</span>
                    <span>{worker.routable ? "routable" : "non routable"}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.muted}>
            Digital Workforce :{" "}
            {workforce ? (
              <>
                {workforce.total} agent(s)
                {Object.entries(workforce.byStatus).map(([s, n]) => (
                  <span key={s}> · {`${s} ${n}`}</span>
                ))}
              </>
            ) : (
              <strong>
                {
                  SECTION_LABEL[
                    model.workforce.state as Exclude<typeof model.workforce.state, "CONNECTED">
                  ]
                }
              </strong>
            )}
          </p>
        </section>

        {/* ── Propositions (Proactive Supervisor) ──────────────────────────── */}
        <section className={styles.section} aria-labelledby="proposals-heading">
          <h2 id="proposals-heading" className={styles.sectionTitle}>
            Propositions ICOS
          </h2>
          <SectionState section={model.proposals} empty="Aucune proposition en cours." />
          <DegradedNote section={model.proposals} />
          {model.proposals.items.length > 0 && (
            <div className={styles.proposalsList}>
              {model.proposals.items.map((proposal) => (
                <article key={proposal.id} className={styles.proposalCard}>
                  <div className={styles.proposalIcon} aria-hidden="true">
                    ∴
                  </div>
                  <div className={styles.proposalContent}>
                    <h3 className={styles.proposalTitle}>{proposal.title}</h3>
                    <p className={styles.proposalDesc}>{proposal.description}</p>
                    <p className={styles.muted}>
                      {proposal.reason} · risque {proposal.risk} · urgence {proposal.urgency}
                      {proposal.scope ? ` · ${proposal.scope}` : ""}
                    </p>
                    <span
                      className={`${styles.proposalStatus} ${styles[`proposal-${proposal.cssState}`]}`}
                    >
                      {proposal.state}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* ── Activité récente (durable audit log) ─────────────────────────── */}
        <section className={styles.section} aria-labelledby="activity-heading">
          <h2 id="activity-heading" className={styles.sectionTitle}>
            Activité récente
          </h2>
          <SectionState section={model.activity} empty="Aucune activité enregistrée." />
          <DegradedNote section={model.activity} />
          {model.activity.items.length > 0 && (
            <ul className={styles.activityList}>
              {model.activity.items.map((activity) => (
                <li key={activity.id} className={styles.activityItem}>
                  <div className={styles.activityIcon} aria-hidden="true">
                    {ACTIVITY_GLYPH[activity.tone]}
                  </div>
                  <div className={styles.activityContent}>
                    <h3 className={styles.activityTitle}>{activity.type}</h3>
                    <p className={styles.activityDesc}>
                      {activity.actorKind} {activity.actor}
                      {activity.taskId ? ` · tâche ${activity.taskId}` : ""}
                    </p>
                  </div>
                  <time className={styles.activityTime} dateTime={activity.at}>
                    {at(activity.at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <MobileNav active={activeNav} onChange={setActiveNav} />
    </main>
  );
}
