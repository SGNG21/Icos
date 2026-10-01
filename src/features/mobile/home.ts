import type { HealthLevel } from "@/features/cockpit/snapshot";
import {
  ACTIVE_MISSION,
  type Alert,
  type MissionSummary,
  type TimelineEntry,
  type WorkerView,
} from "@/features/cockpit/snapshot";
import { isReal, missing, real, type MissingKind, type Truth } from "@/features/cockpit/truth";
import type { MissionStatus } from "@/core/mission/contracts";
import type { ProposalState } from "@/server/proactive/read-port";

/**
 * Mobile Home read model — PURE projection.
 *
 * The Mobile Home is a read/control surface, never an authority: this module only
 * re-shapes facts already read from canonical ICOS sources (CORE3 missions and worker
 * registry, the durable audit log, the action repository, the Proactive Supervisor
 * store, the Digital Workforce read model) into the sections the phone renders.
 *
 * It derives nothing that ICOS does not already state. Anything without a canonical
 * source stays an explicit non-value: a section is CONNECTED, DEGRADED (real but one of
 * its supporting sources is missing), EMPTY (the source answered, with nothing in it),
 * or UNKNOWN / UNAVAILABLE / NOT_CONNECTED. Unknown is never rendered as healthy and
 * empty is never rendered as disconnected.
 */
export type SectionState =
  "CONNECTED" | "DEGRADED" | "EMPTY" | "UNKNOWN" | "UNAVAILABLE" | "NOT_CONNECTED";

export interface Section<T> {
  state: SectionState;
  items: readonly T[];
  /** Why the section is not fully connected (verbatim from the canonical read). */
  reason: string | null;
  /** Backend requirement id, when the missing Truth names one. */
  requirement: string | null;
}

/** Truth kinds → section vocabulary. A timeout is read as UNKNOWN, never as EMPTY. */
export const STATE_OF_MISSING: Record<MissingKind, SectionState> = {
  unknown: "UNKNOWN",
  not_available: "UNAVAILABLE",
  not_connected: "NOT_CONNECTED",
};

export const isConnected = (s: SectionState): boolean =>
  s === "CONNECTED" || s === "DEGRADED" || s === "EMPTY";

function section<A, B>(truth: Truth<readonly A[]>, map: (a: A) => B): Section<B> {
  if (!isReal(truth)) {
    return {
      state: STATE_OF_MISSING[truth.kind],
      items: [],
      reason: truth.reason,
      requirement: truth.requirement ?? null,
    };
  }
  const items = truth.value.map(map);
  return { state: items.length ? "CONNECTED" : "EMPTY", items, reason: null, requirement: null };
}

/**
 * A section that rendered real rows but lost a supporting source is DEGRADED, never
 * CONNECTED. An EMPTY section stays EMPTY: the source that answered with nothing is not
 * made UNKNOWN because a *different*, supporting source failed.
 */
function degradeIfMissing<T>(s: Section<T>, support: Truth<unknown>): Section<T> {
  if (isReal(support) || s.state !== "CONNECTED" || s.items.length === 0) return s;
  return {
    ...s,
    state: "DEGRADED",
    reason: support.reason,
    requirement: support.requirement ?? null,
  };
}

// ── Facts handed over by the server loader (plain shapes: no server import here) ──

/** Canonical pending action awaiting a human decision (ActionRepository). */
export interface PendingApprovalFact {
  id: string;
  kind: string;
  risk: string;
  taskId: string | null;
  requestedAt: string;
  requestedBy: string;
}

/** Open Proactive Supervisor situation, with the proposal it produced (if any). */
export interface SupervisorSituationFact {
  id: string;
  domain: string;
  eventType: string;
  subject: string;
  kind: "problem" | "opportunity" | "information";
  severity: "low" | "medium" | "high" | "critical";
  state: "open" | "resolved" | "dismissed";
  eventCount: number;
  lastSeenAt: string;
  /** Which client/project the situation belongs to; the digest spans all of them. */
  clientScope: string | null;
  projectScope: string | null;
  proposal: {
    /** Canonical rule action name (the supervisor proposes capabilities, never an agent). */
    action: string;
    desiredOutcome: string;
    reason: string;
    risk: string;
    urgency: string;
    state: ProposalState;
  } | null;
}

/** Digital Workforce agent census (its own read model, not the worker registry). */
export interface WorkforceCensus {
  total: number;
  byStatus: Record<string, number>;
}

// ── Section rows ─────────────────────────────────────────────────────────────

export interface ActiveMissionRow {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  updatedAt: string;
  /**
   * Head of the canonical critical path. Missing when ICOS derives no path for this
   * mission (it derives one for the focus mission only) — never claimed as undiscoverable.
   */
  currentTask: Truth<string>;
  /** Mission-level approval gate, read from the canonical mission status. */
  approvalRequired: boolean;
  attention: boolean;
  /** Completed vs total mission tasks — the only canonically derivable progress. */
  progress: { completed: number; total: number; pct: number } | null;
  /** Workers holding a non-terminal dispatch on this mission. */
  workersActive: Truth<number>;
}

export interface MissionRow {
  id: string;
  title: string;
  status: MissionStatus;
  updatedAt: string;
  running: number;
  failed: number;
  progress: { completed: number; total: number; pct: number } | null;
  attention: "none" | "needs_review" | "blocked";
}

export interface WorkerRow {
  id: string;
  name: string;
  runtime: string;
  /** Registry health — NOT catalog presence. A listed model is not a healthy worker. */
  health: WorkerView["health"];
  status: WorkerView["status"];
  availability: WorkerView["availability"];
  probeOutcome: WorkerView["probe"]["outcome"];
  /** Declared in the registry, never inferred from a model catalog. */
  model: Truth<string>;
  provider: Truth<string>;
  slots: { used: Truth<number>; max: number };
  /**
   * The mission task dispatched to this worker. `real(null)` means the ledger was read
   * and this worker holds none; a missing Truth means the dispatch ledger was unreadable,
   * so "no task" must NOT be asserted.
   */
  currentTask: Truth<{ missionId: string; taskId: string; state: string; others: number } | null>;
  routable: boolean;
}

export interface IncidentRow {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  at: string | null;
  source: "alert" | "supervisor";
  missionId: string | null;
  /** Client/project the situation belongs to, when the supervisor records one. */
  scope: string | null;
}

export interface ProposalRow {
  id: string;
  scope: string | null;
  title: string;
  description: string;
  risk: string;
  urgency: string;
  reason: string;
  /** Canonical Proactive Supervisor proposal state, shown verbatim. */
  state: ProposalState;
  cssState: "proposed" | "awaiting_approval" | "approved" | "rejected";
}

export interface ActivityRow {
  id: string;
  at: string;
  type: string;
  actor: string;
  actorKind: string;
  tone: TimelineEntry["tone"];
  taskId: string | null;
}

export interface MobileHomeModel {
  generatedAt: string;
  health: { level: HealthLevel; reasons: readonly string[] };
  activeMission: Section<ActiveMissionRow>;
  missions: Section<MissionRow>;
  workers: Section<WorkerRow>;
  /** Digital Workforce census, separate from the worker registry on purpose. */
  workforce: Section<WorkforceCensus>;
  approvals: Section<PendingApprovalFact>;
  /** `tasks.write`: without it the Cognitive Runtime refuses a turn. */
  canConverse: boolean;
  /** `approvals.decide`: without it the pending actions are read-only here. */
  canDecideApprovals: boolean;
  /** `missions.write`: without it a Cognitive Runtime proposal cannot be decided here. */
  canDecideProposals: boolean;
  incidents: Section<IncidentRow>;
  proposals: Section<ProposalRow>;
  activity: Section<ActivityRow>;
}

// ── Presentation of canonical statuses (the UI invents no status) ────────────

/** Existing stylesheet tones; the canonical status itself is always displayed as text. */
export const MISSION_STATUS_CSS: Record<MissionStatus, string> = {
  draft: "UNKNOWN",
  planning: "planning",
  ready: "planning",
  running: "running",
  blocked: "blocked",
  awaiting_approval: "blocked",
  succeeded: "completed",
  failed: "failed",
  cancelled: "UNKNOWN",
};

export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  draft: "Brouillon",
  planning: "Planification",
  ready: "Prête",
  running: "En cours",
  blocked: "Bloquée",
  awaiting_approval: "À valider",
  succeeded: "Réussie",
  failed: "Échouée",
  cancelled: "Annulée",
};

export const WORKER_HEALTH_CSS: Record<WorkerView["health"], string> = {
  healthy: "healthy",
  degraded: "degraded",
  unhealthy: "unhealthy",
  unknown: "UNKNOWN",
};

export const SECTION_LABEL: Record<Exclude<SectionState, "CONNECTED">, string> = {
  DEGRADED: "DÉGRADÉE",
  EMPTY: "AUCUN",
  UNKNOWN: "INCONNU",
  UNAVAILABLE: "INDISPONIBLE",
  NOT_CONNECTED: "NON CONNECTÉE",
};

const progressOf = (m: MissionSummary) =>
  m.total > 0 ? { completed: m.completed, total: m.total, pct: m.progressPct } : null;

const attentionOf = (m: MissionSummary): MissionRow["attention"] =>
  m.status === "blocked" || m.status === "failed" || m.failed > 0
    ? "blocked"
    : m.attention
      ? "needs_review"
      : "none";

/**
 * Which client/project a situation belongs to. The digest spans every scope of the
 * tenant, so the owner must be able to tell them apart rather than see one flat list.
 */
const scopeOf = (s: SupervisorSituationFact): string | null =>
  [s.clientScope, s.projectScope].filter(Boolean).join(" / ") || null;

const SUPERVISOR_SEVERITY: Record<SupervisorSituationFact["severity"], IncidentRow["severity"]> = {
  critical: "critical",
  high: "critical",
  medium: "warning",
  low: "info",
};

const PROPOSAL_CSS: Record<ProposalState, ProposalRow["cssState"]> = {
  pending: "proposed",
  delivering: "proposed",
  awaiting_human: "awaiting_approval",
  submitted: "approved",
  not_connected: "proposed",
  denied: "rejected",
  cancelled: "rejected",
  failed: "rejected",
};

export interface MobileHomeInput {
  generatedAt: string;
  health: { level: HealthLevel; reasons: readonly string[] };
  missions: Truth<readonly MissionSummary[]>;
  /** Canonical focus derivation (longest remaining critical path, attention first). */
  focus: { missionId: string; path: { id: string; title: string; status: string }[] } | null;
  workers: Truth<readonly WorkerView[]>;
  /**
   * The dispatch-attempt ledger, read separately from the worker registry by the cockpit
   * loader. Carried here because `WorkerView.assignments` is a plain array: without this
   * truth an unreadable ledger would look like "no worker is doing anything".
   */
  dispatchLedger: Truth<unknown>;
  timeline: Truth<readonly TimelineEntry[]>;
  /** Alerts the cockpit already derives from canonical sources. */
  alerts: readonly Alert[];
  approvals: Truth<readonly PendingApprovalFact[]>;
  canConverse: boolean;
  canDecideApprovals: boolean;
  canDecideProposals: boolean;
  workforce: Truth<WorkforceCensus>;
  supervisor: Truth<readonly SupervisorSituationFact[]>;
  /** How many recent audit entries the phone shows. */
  activityLimit?: number;
}

export function buildMobileHome(input: MobileHomeInput): MobileHomeModel {
  const missions = section(input.missions, (m): MissionRow => ({
    id: m.id,
    title: m.title,
    status: m.status,
    updatedAt: m.updatedAt,
    running: m.running,
    failed: m.failed,
    progress: progressOf(m),
    attention: attentionOf(m),
  }));

  const activeMission = buildActiveMission(input);

  // The registry says a worker EXISTS; the dispatch ledger says what it is DOING. They
  // are read independently, so an unreadable ledger must not become "no task dispatched".
  const ledger = ledgerTruth(input);
  const workers = degradeIfMissing(
    section(input.workers, (w): WorkerRow => {
      const assignment = w.assignments[0];
      return {
        id: w.id,
        name: w.name,
        runtime: w.runtime,
        health: w.health,
        status: w.status,
        availability: w.availability,
        probeOutcome: w.probe.outcome,
        model: w.model,
        provider: w.provider,
        slots: w.slots,
        currentTask: isReal(ledger)
          ? real(
              assignment
                ? {
                    missionId: assignment.missionId,
                    taskId: assignment.taskId,
                    state: assignment.state,
                    others: Math.max(0, w.assignments.length - 1),
                  }
                : null,
            )
          : (ledger as WorkerRow["currentTask"]),
        routable: w.routable,
      };
    }),
    ledger,
  );

  const workforce: Section<WorkforceCensus> = isReal(input.workforce)
    ? {
        state: input.workforce.value.total > 0 ? "CONNECTED" : "EMPTY",
        items: [input.workforce.value],
        reason: null,
        requirement: null,
      }
    : {
        state: STATE_OF_MISSING[input.workforce.kind],
        items: [],
        reason: input.workforce.reason,
        requirement: input.workforce.requirement ?? null,
      };

  const activity = section(
    isReal(input.timeline)
      ? { kind: "real" as const, value: input.timeline.value.slice(0, input.activityLimit ?? 20) }
      : input.timeline,
    (e): ActivityRow => ({
      id: e.id,
      at: e.at,
      type: e.type,
      actor: e.actor,
      actorKind: e.actorKind,
      tone: e.tone,
      taskId: e.taskId,
    }),
  );

  return {
    generatedAt: input.generatedAt,
    health: input.health,
    activeMission,
    missions,
    workers,
    workforce,
    approvals: section(input.approvals, (a) => a),
    canConverse: input.canConverse,
    canDecideApprovals: input.canDecideApprovals,
    canDecideProposals: input.canDecideProposals,
    incidents: buildIncidents(input),
    proposals: buildProposals(input.supervisor),
    activity,
  };
}

/** The first missing Truth of a list, or a real marker when all of them are real. */
function firstMissing(truths: readonly Truth<unknown>[]): Truth<null> {
  const bad = truths.find((t) => !isReal(t));
  return bad ? (bad as Truth<null>) : real(null);
}

/**
 * Whether "what workers are doing" is known. Both dispatch reads must have succeeded:
 * `dispatchLedger` (the attempts behind `WorkerView.assignments`) and the per-worker
 * occupied-slot count. Either one missing makes every dispatch-derived number UNKNOWN.
 */
function ledgerTruth(input: MobileHomeInput): Truth<null> {
  if (!isReal(input.dispatchLedger)) return input.dispatchLedger as Truth<null>;
  if (!isReal(input.workers)) return input.workers as Truth<null>;
  return firstMissing(input.workers.value.map((w) => w.slots.used));
}

function buildActiveMission(input: MobileHomeInput): Section<ActiveMissionRow> {
  if (!isReal(input.missions)) {
    return {
      state: STATE_OF_MISSING[input.missions.kind],
      items: [],
      reason: input.missions.reason,
      requirement: input.missions.requirement ?? null,
    };
  }
  const summaries = input.missions.value;
  // The cockpit's focus derivation first; otherwise the most urgent active mission in the
  // list the loader already sorted (attention first, then most recently updated).
  const focus = input.focus;
  const focused = focus ? summaries.find((m) => m.id === focus.missionId) : undefined;
  const mission = focused ?? summaries.find((m) => ACTIVE_MISSION.has(m.status));
  if (!mission) {
    return { state: "EMPTY", items: [], reason: null, requirement: null };
  }
  // ICOS derives a critical path for the focus mission only; for any other mission the
  // current task is NOT AVAILABLE (not "undiscoverable"), and that reason is shown.
  const next = focused && focus ? focus.path.find((n) => n.status !== "COMPLETED") : undefined;
  const currentTask: Truth<string> = next
    ? real(next.title, "head of the canonical critical path")
    : focused
      ? // The path IS known and complete: a fact ICOS states, not a missing source.
        real("aucune — chemin critique terminé", "canonical critical path, fully completed")
      : missing("not_available", "ICOS ne dérive un chemin critique que pour la mission en focus.");

  const ledger = ledgerTruth(input);
  const workersActive: Truth<number> = isReal(ledger)
    ? real(
        new Set(
          (isReal(input.workers) ? input.workers.value : [])
            .filter((w) => w.assignments.some((a) => a.missionId === mission.id))
            .map((w) => w.id),
        ).size,
        "workers holding a non-terminal dispatch on this mission",
      )
    : (ledger as Truth<number>);

  const row: ActiveMissionRow = {
    id: mission.id,
    title: mission.title,
    objective: mission.objective,
    status: mission.status,
    updatedAt: mission.updatedAt,
    currentTask,
    approvalRequired: mission.status === "awaiting_approval",
    attention: mission.attention,
    progress: progressOf(mission),
    workersActive,
  };
  return degradeIfMissing(
    { state: "CONNECTED", items: [row], reason: null, requirement: null },
    ledger,
  );
}

function buildIncidents(input: MobileHomeInput): Section<IncidentRow> {
  const fromAlerts: IncidentRow[] = input.alerts
    .filter((a) => a.severity !== "P2")
    .map((a) => ({
      id: `alert:${a.id}`,
      severity: a.severity === "P0" ? ("critical" as const) : ("warning" as const),
      title: a.title,
      description: a.detail ?? a.category,
      at: a.at ?? null,
      source: "alert" as const,
      missionId: null,
      scope: null,
    }));

  if (!isReal(input.supervisor)) {
    return {
      state: fromAlerts.length ? "DEGRADED" : STATE_OF_MISSING[input.supervisor.kind],
      items: fromAlerts,
      reason: input.supervisor.reason,
      requirement: input.supervisor.requirement ?? null,
    };
  }
  const fromSupervisor: IncidentRow[] = input.supervisor.value
    .filter((s) => s.state === "open" && s.kind === "problem")
    .map((s) => ({
      id: `situation:${s.id}`,
      severity: SUPERVISOR_SEVERITY[s.severity],
      title: `${s.eventType} · ${s.subject}`,
      description: `${s.domain} — ${s.eventCount} événement(s) agrégé(s)`,
      at: s.lastSeenAt,
      source: "supervisor" as const,
      missionId: null,
      scope: scopeOf(s),
    }));
  const items = [...fromAlerts, ...fromSupervisor];
  return {
    state: items.length ? "CONNECTED" : "EMPTY",
    items,
    reason: null,
    requirement: null,
  };
}

function buildProposals(
  supervisor: Truth<readonly SupervisorSituationFact[]>,
): Section<ProposalRow> {
  return section(
    isReal(supervisor)
      ? {
          kind: "real" as const,
          value: supervisor.value.filter(
            (
              s,
            ): s is SupervisorSituationFact & {
              proposal: NonNullable<SupervisorSituationFact["proposal"]>;
            } => s.proposal !== null,
          ),
        }
      : supervisor,
    (s): ProposalRow => ({
      id: s.id,
      scope: scopeOf(s),
      title: s.proposal.action,
      description: s.proposal.desiredOutcome,
      state: s.proposal.state,
      risk: s.proposal.risk,
      urgency: s.proposal.urgency,
      reason: s.proposal.reason,
      cssState: PROPOSAL_CSS[s.proposal.state],
    }),
  );
}
