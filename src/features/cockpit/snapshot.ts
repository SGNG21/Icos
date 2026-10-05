import type { AuditEntry, Task } from "@/core/contracts";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { Mission, MissionTask } from "@/core/mission/contracts";

import { buildDag, type DagInputTask, type NodeStatus } from "./dag";
import {
  buildPipeline,
  integrationBacklog,
  leaseState,
  type LeaseState,
  type QualityFact,
  type WorkspaceFact,
} from "./pipeline";
import {
  costMetric,
  memoryMetric,
  providerHealthMetric,
  selfDevelopmentMetric,
  tokenThroughputMetric,
  type TruthProjection,
} from "./truth-projection";
import { isReal, missing, real, type Truth } from "./truth";

/**
 * Cockpit snapshot: the single read model every cockpit screen renders.
 *
 * Pure function of canonical ICOS data already read under the caller's
 * operational scope (see load.ts). It derives, labels and aggregates; it never
 * invents. Anything without a canonical source is a `missing` Truth that points
 * at its backend requirement.
 */

/** Visual semantics (locked visual direction). Never the only information channel. */
export type Tone = "flow" | "ok" | "critical" | "autonomy" | "warn" | "unknown";

export interface MissionWithTasks {
  mission: Mission;
  tasks: MissionTask[];
}

export interface CockpitSources {
  now: Date;
  backend: "postgres" | "memory";
  scope: "global" | "linked";
  tasks: Truth<Task[]>;
  missions: Truth<MissionWithTasks[]>;
  workers: Truth<WorkerRegistryEntry[]>;
  /** One entry per non-terminal dispatch holding a worker (worker id). */
  activeAssignments: Truth<string[]>;
  /** Non-terminal dispatch attempts of in-scope active mission tasks. */
  attempts: Truth<DispatchAttempt[]>;
  pendingApprovals: Truth<number>;
  audit: Truth<AuditEntry[]>;
  /** Pending quality-control jobs of in-scope missions. */
  qualityJobs: Truth<QualityFact[]>;
  /** Count of ESCALATED jobs of in-scope missions; `qualityJobs` excludes them by design. */
  escalatedJobs: Truth<number>;
  /** Workspace registry: integration lifecycle, leases, fencing tokens. */
  workspaces: Truth<WorkspaceFact[]>;
  /**
   * Measured sources behind tiles that were NOT AVAILABLE (decision 0069). Optional so a
   * caller that cannot read them keeps the honest miss, requirement code included.
   */
  truth?: TruthProjection;
}

export type MetricKey =
  | "globalHealth"
  | "autonomyLevel"
  | "activeMissions"
  | "activeWorkers"
  | "readyQueue"
  | "reviewBacklog"
  | "integrationBacklog"
  | "mustNow"
  | "providerHealth"
  | "cost"
  | "tokenThroughput"
  | "latency"
  | "humanInterventions";

export type HealthLevel = "healthy" | "degraded" | "critical" | "unknown";

export type AlertCategory =
  | "CRITICAL"
  | "SECURITY"
  | "MISSION"
  | "WORKER"
  | "PROVIDER"
  | "RECOVERY"
  | "GOVERNANCE"
  | "SELF_DEVELOPMENT"
  | "COST"
  | "CAPACITY";

export interface Alert {
  id: string;
  category: AlertCategory;
  /** P0 immediate human attention · P1 notify · P2 cockpit only. */
  severity: "P0" | "P1" | "P2";
  title: string;
  detail?: string;
  href?: string;
  at?: string;
}

export interface WorkerAssignment {
  missionId: string;
  missionTaskId: string;
  taskId: string;
  attempt: number;
  state: DispatchAttempt["state"];
  dispatchedAt: string | null;
  failureClass: string | null;
  lastError: string | null;
}

export interface WorkerView {
  id: string;
  name: string;
  kind: string;
  runtime: string;
  runtimeSupport: string;
  status: WorkerRegistryEntry["status"];
  health: WorkerRegistryEntry["health"];
  availability: WorkerRegistryEntry["availability"];
  probe: {
    outcome: WorkerRegistryEntry["lastProbeOutcome"];
    at: string | null;
    ageMs: number | null;
  };
  /** Worker ≠ Model ≠ Provider ≠ Account ≠ Capacity slot: each is its own Truth. */
  model: Truth<string>;
  provider: Truth<string>;
  account: Truth<string>;
  slots: { used: Truth<number>; max: number };
  pool: { name: string; limit: number | null } | null;
  capabilities: string[];
  features: string[];
  tags: string[];
  /** Registry metadata minus anything that looks like a credential. */
  metadata: Record<string, string>;
  /** Registry metadata keys withheld from display (not allowlisted or credential-like). */
  metadataHidden: number;
  assignments: WorkerAssignment[];
  /** Workspace leases held by this worker (workspace registry). */
  leases: Truth<
    {
      slug: string;
      status: string;
      state: LeaseState;
      expiresAt: string | null;
      fencingToken: number;
    }[]
  >;
  tone: Tone;
  routable: boolean;
}

export interface MissionSummary {
  id: string;
  title: string;
  objective: string;
  status: Mission["status"];
  updatedAt: string;
  total: number;
  completed: number;
  running: number;
  failed: number;
  ready: number;
  progressPct: number;
  remainingCriticalPath: number;
  attention: boolean;
  tone: Tone;
}

export interface SystemDomain {
  key: string;
  label: string;
  tone: Tone;
  metric: Truth<number>;
  metricLabel: string;
  /** 0 = no real flow → no animation. Drives flow intensity. */
  activity: number;
  href: string;
}

export interface TimelineEntry {
  id: string;
  at: string;
  type: string;
  actor: string;
  actorKind: string;
  taskId: string | null;
  tone: Tone;
}

export interface CockpitSnapshot {
  generatedAt: string;
  backend: CockpitSources["backend"];
  scope: CockpitSources["scope"];
  health: { level: HealthLevel; reasons: string[] };
  metrics: Record<MetricKey, Truth<number | string>>;
  domains: SystemDomain[];
  alerts: Alert[];
  workers: Truth<WorkerView[]>;
  missions: Truth<MissionSummary[]>;
  focus: {
    missionId: string;
    title: string;
    path: { id: string; title: string; status: NodeStatus }[];
  } | null;
  timeline: Truth<TimelineEntry[]>;
}

const DAY_MS = 86_400_000;
/** Mission statuses CORE3 considers in flight. One authority, shared by every surface. */
export const ACTIVE_MISSION: ReadonlySet<Mission["status"]> = new Set([
  "planning",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
]);
const SECRET_KEY = /key|token|secret|pass|credential|cookie|auth|bearer|private/i;

/** Values that look like credentials whatever their key: URL userinfo, bearer tokens, key prefixes. */
const SECRET_VALUE = /:\/\/[^/\s@]+@|\bbearer\s|\b(sk|pk|rk|ghp|gho|xox[abp])[-_][a-z0-9]{8,}/i;

/** Raw error text can carry provider internals: owner/admin (global) scope only, truncated. */
export function redactError(text: string | undefined, global: boolean): string | undefined {
  return global && text ? text.slice(0, 200) : undefined;
}

/**
 * Display ALLOWLIST: registration keys the cockpit knows (decision 0054 compute fleet + BR-03
 * identity). Anything else stays hidden (counted, never shown): a free-form key can carry
 * anything. Allowed values are still dropped when they look like credentials.
 */
export const METADATA_DISPLAY_KEYS = [
  "model",
  "provider",
  "modelFamily",
  "tierHint",
  "account",
  "region",
  "contextWindow",
  "executionBudgetMs",
  "maxExecutionBudgetMs",
  "version",
] as const;
const DISPLAYABLE = new Set<string>(METADATA_DISPLAY_KEYS);

export function safeMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) => DISPLAYABLE.has(key) && !SECRET_KEY.test(key) && !SECRET_VALUE.test(value),
    ),
  );
}

export const hiddenMetadataCount = (metadata: Record<string, string>) =>
  Object.keys(metadata).length - Object.keys(safeMetadata(metadata)).length;

/**
 * Reads ONE registration key as a Truth. It must be handed SANITIZED metadata: it used to be
 * called with `w.metadata` raw while the `metadata` block beside it went through
 * `safeMetadata`, so a `model` / `provider` / `account` value that looked like a credential
 * (`SECRET_VALUE`) was filtered out of the metadata list and then rendered anyway as the
 * worker's declared model. A dropped key reads as `not_available`, which is the honest answer.
 */
function declared(
  metadata: Record<string, string>,
  key: string,
  requirement: string,
): Truth<string> {
  const value = metadata[key];
  return value
    ? real(value, "declared in worker registry metadata (not verified by a probe)")
    : missing(
        "not_available",
        `The registry does not record a ${key} for this worker.`,
        requirement,
      );
}

export function buildWorkerViews(
  workers: readonly WorkerRegistryEntry[],
  activeAssignments: Truth<string[]>,
  attempts: Truth<DispatchAttempt[]>,
  now: Date,
  workspaces: Truth<WorkspaceFact[]> = missing("unknown", "Workspace registry not read."),
): WorkerView[] {
  const load = new Map<string, number>();
  if (isReal(activeAssignments)) {
    for (const id of activeAssignments.value) load.set(id, (load.get(id) ?? 0) + 1);
  }
  const byWorker = new Map<string, WorkerAssignment[]>();
  if (isReal(attempts)) {
    for (const a of attempts.value) {
      if (!a.workerId) continue;
      const list = byWorker.get(a.workerId) ?? [];
      list.push({
        missionId: a.missionId,
        missionTaskId: a.missionTaskId,
        taskId: a.taskId,
        attempt: a.attempt,
        state: a.state,
        dispatchedAt: a.dispatchedAt ? new Date(a.dispatchedAt).toISOString() : null,
        failureClass: a.failureClass ?? null,
        lastError: a.lastError ?? null,
      });
      byWorker.set(a.workerId, list);
    }
  }

  return workers.map((w) => {
    const routable =
      w.status === "active" &&
      w.health === "healthy" &&
      w.availability === "available" &&
      w.lastProbeOutcome === "ok";
    // ONE sanitized view, shared by the declared() Truths and the metadata block below.
    const safe = safeMetadata(w.metadata);
    return {
      id: w.id,
      name: w.displayName,
      kind: w.workerKind,
      runtime: w.runtime,
      runtimeSupport: w.runtimeSupport,
      status: w.status,
      health: w.health,
      availability: w.availability,
      probe: {
        outcome: w.lastProbeOutcome,
        at: w.lastProbeAt,
        ageMs: w.lastProbeAt ? now.getTime() - Date.parse(w.lastProbeAt) : null,
      },
      model: declared(safe, "model", "BR-03"),
      provider: declared(safe, "provider", "BR-03"),
      account: declared(safe, "account", "BR-03"),
      slots: {
        used: isReal(activeAssignments)
          ? real(load.get(w.id) ?? 0, "non-terminal dispatches in the ledger")
          : activeAssignments,
        max: w.maxConcurrency,
      },
      pool: w.capacityPool ? { name: w.capacityPool, limit: w.capacityPoolLimit } : null,
      capabilities: [...w.capabilities],
      features: [...w.features],
      tags: [...w.tags],
      metadata: safe,
      metadataHidden: hiddenMetadataCount(w.metadata),
      assignments: byWorker.get(w.id) ?? [],
      leases: isReal(workspaces)
        ? real(
            workspaces.value
              .filter((x) => x.workerId === w.id && x.leaseOwner && x.releasedAt === null)
              .map((x) => ({
                slug: x.slug,
                status: x.status,
                state: leaseState(x, now),
                expiresAt: x.leaseExpiresAt,
                fencingToken: x.fencingToken,
              })),
          )
        : (workspaces as WorkerView["leases"]),
      tone: workerTone(w),
      routable,
    };
  });
}

function workerTone(w: WorkerRegistryEntry): Tone {
  if (w.status !== "active") return "unknown";
  if (w.health === "unhealthy" || w.lastProbeOutcome === "failed") return "critical";
  if (w.health === "degraded" || w.availability === "unavailable") return "warn";
  if (w.health === "healthy" && w.lastProbeOutcome === "ok") return "ok";
  return "unknown";
}

function dagInput(
  tasks: readonly MissionTask[],
  attempts: Truth<DispatchAttempt[]>,
): DagInputTask[] {
  const byMissionTask = new Map<string, DispatchAttempt>();
  if (isReal(attempts)) for (const a of attempts.value) byMissionTask.set(a.missionTaskId, a);
  return tasks.map((task) => {
    const a = byMissionTask.get(task.id);
    return {
      task,
      attempt: a
        ? {
            attempt: a.attempt,
            state: a.state,
            workerId: a.workerId,
            workerKind: a.workerKind,
            failureClass: a.failureClass,
            lastError: a.lastError,
            dispatchedAt: a.dispatchedAt ? new Date(a.dispatchedAt).toISOString() : undefined,
          }
        : undefined,
    };
  });
}

export function summarizeMissions(
  missions: readonly MissionWithTasks[],
  attempts: Truth<DispatchAttempt[]>,
): { summaries: MissionSummary[]; focus: CockpitSnapshot["focus"] } {
  let focus: CockpitSnapshot["focus"] = null;
  let focusScore = -1;
  const summaries = missions.map(({ mission, tasks }) => {
    const dag = buildDag(dagInput(tasks, attempts));
    const count = (s: NodeStatus) => dag.nodes.filter((n) => n.status === s).length;
    const completed = count("COMPLETED");
    const failed = count("FAILED_TERMINAL");
    const attention =
      mission.status === "blocked" ||
      mission.status === "failed" ||
      mission.status === "awaiting_approval" ||
      failed > 0;
    const tone: Tone =
      mission.status === "failed" || mission.status === "blocked" || failed > 0
        ? "critical"
        : mission.status === "awaiting_approval"
          ? "warn"
          : mission.status === "running"
            ? "ok"
            : mission.status === "succeeded"
              ? "ok"
              : "flow";

    if (ACTIVE_MISSION.has(mission.status) && dag.criticalPath.length > 0) {
      // Attention first, then the longest remaining chain.
      const score = (attention ? 10_000 : 0) + dag.criticalPath.length;
      if (score > focusScore) {
        focusScore = score;
        const byId = new Map(dag.nodes.map((n) => [n.id, n]));
        focus = {
          missionId: mission.id,
          title: mission.title,
          path: dag.criticalPath.map((id) => ({
            id,
            title: byId.get(id)!.title,
            status: byId.get(id)!.status,
          })),
        };
      }
    }

    return {
      id: mission.id,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      updatedAt: new Date(mission.updatedAt).toISOString(),
      total: tasks.length,
      completed,
      running: count("RUNNING") + count("DISPATCHED"),
      failed,
      ready: count("READY"),
      progressPct: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
      remainingCriticalPath: dag.criticalRemaining,
      attention,
      tone,
    };
  });
  summaries.sort(
    (a, b) => Number(b.attention) - Number(a.attention) || b.updatedAt.localeCompare(a.updatedAt),
  );
  return { summaries, focus };
}

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2 } as const;

export function deriveAlerts(
  sources: CockpitSources,
  workers: readonly WorkerView[] | null,
  missions: readonly MissionSummary[] | null,
): Alert[] {
  const alerts: Alert[] = [];
  const since = sources.now.getTime() - DAY_MS;

  if (sources.backend === "memory") {
    alerts.push({
      id: "backend-memory",
      category: "CRITICAL",
      severity: "P1",
      title: "In-memory demo backend",
      detail:
        "PERSISTENCE is not postgres: data comes from development seeds, not from ICOS state.",
      href: "/cockpit/system",
    });
  }

  for (const [label, truth] of Object.entries({
    tasks: sources.tasks,
    missions: sources.missions,
    workers: sources.workers,
    dispatch: sources.attempts,
    approvals: sources.pendingApprovals,
    audit: sources.audit,
  })) {
    if (truth.kind === "unknown") {
      alerts.push({
        id: `source-${label}`,
        category: "RECOVERY",
        severity: "P1",
        title: `Cockpit cannot read ${label}`,
        detail: truth.reason,
        href: "/cockpit/system",
      });
    }
  }

  if (isReal(sources.pendingApprovals) && sources.pendingApprovals.value > 0) {
    alerts.push({
      id: "approvals",
      category: "GOVERNANCE",
      severity: "P0",
      title: `${sources.pendingApprovals.value} action(s) await your approval`,
      href: "/#approvals",
    });
  }

  for (const m of missions ?? []) {
    if (m.status === "blocked" || m.status === "awaiting_approval") {
      alerts.push({
        id: `mission-${m.id}`,
        category: m.status === "blocked" ? "MISSION" : "GOVERNANCE",
        severity: "P0",
        title: `Mission ${m.status === "blocked" ? "blocked" : "awaiting approval"}: ${m.title}`,
        href: `/cockpit/missions/${m.id}`,
        at: m.updatedAt,
      });
    } else if (m.status === "failed" || m.failed > 0) {
      alerts.push({
        id: `mission-${m.id}`,
        category: "MISSION",
        severity: "P1",
        title:
          m.status === "failed"
            ? `Mission failed: ${m.title}`
            : `${m.failed} failed task(s) in ${m.title}`,
        href: `/cockpit/missions/${m.id}`,
        at: m.updatedAt,
      });
    }
  }

  if (workers) {
    for (const w of workers) {
      if (w.status !== "active") continue;
      if (w.tone === "critical") {
        alerts.push({
          id: `worker-${w.id}`,
          category: "WORKER",
          severity: "P1",
          title: `Worker ${w.name} ${w.probe.outcome === "failed" ? "probe failed" : "unhealthy"}`,
          href: `/cockpit/workers#${w.id}`,
          at: w.probe.at ?? undefined,
        });
      } else if (
        w.probe.outcome === "stale" ||
        w.probe.outcome === "never" ||
        w.probe.outcome === "unsupported"
      ) {
        alerts.push({
          id: `worker-${w.id}`,
          category: "WORKER",
          severity: "P2",
          title: `Worker ${w.name}: no current health evidence (${w.probe.outcome})`,
          href: `/cockpit/workers#${w.id}`,
        });
      }
    }
    const activeWork = (missions ?? []).some((m) => m.ready > 0 || m.running > 0);
    if (workers.length > 0 && activeWork && !workers.some((w) => w.routable)) {
      alerts.push({
        id: "capacity-none-routable",
        category: "CAPACITY",
        severity: "P0",
        title: "No routable worker while work is ready",
        detail: "No active worker is healthy, available and backed by a successful probe.",
        href: "/cockpit/workers",
      });
    }
  }

  if (isReal(sources.audit)) {
    const denied = sources.audit.value.filter(
      (e) => e.eventType === "auth.access.denied" && Date.parse(e.occurredAt) >= since,
    );
    if (denied.length > 0) {
      alerts.push({
        id: "security-denied",
        category: "SECURITY",
        severity: "P1",
        title: `${denied.length} denied access attempt(s) in 24h`,
        href: "/cockpit/audit?eventType=auth.access.denied",
        at: denied
          .map((e) => e.occurredAt)
          .sort()
          .at(-1),
      });
    }
  }

  return alerts.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.at ?? "").localeCompare(a.at ?? ""),
  );
}

const HEALTH_CATEGORIES: ReadonlySet<AlertCategory> = new Set([
  "CRITICAL",
  "MISSION",
  "WORKER",
  "CAPACITY",
  "SECURITY",
  "RECOVERY",
]);

export function deriveHealth(
  alerts: readonly Alert[],
  workers: readonly WorkerView[] | null,
): CockpitSnapshot["health"] {
  const relevant = alerts.filter((a) => HEALTH_CATEGORIES.has(a.category) && a.severity !== "P2");
  if (relevant.some((a) => a.severity === "P0")) {
    return { level: "critical", reasons: relevant.map((a) => a.title) };
  }
  if (relevant.length > 0) return { level: "degraded", reasons: relevant.map((a) => a.title) };
  if (workers?.some((w) => w.routable)) {
    const unproven = workers.filter((w) => w.status === "active" && w.tone === "unknown").length;
    return {
      level: "healthy",
      reasons: [
        "At least one worker is routable with fresh probe evidence; no open incident.",
        ...(unproven ? [`${unproven} active worker(s) have no health evidence (UNKNOWN).`] : []),
      ],
    };
  }
  return {
    level: "unknown",
    reasons: [
      workers
        ? "No worker has current health evidence."
        : "Worker health is outside your scope or unreadable.",
    ],
  };
}

function auditTone(type: string): Tone {
  if (type === "auth.access.denied" || type.endsWith(".rejected") || type.endsWith(".failed"))
    return "critical";
  if (type.startsWith("auth.") || type.startsWith("human_") || type.startsWith("role."))
    return "flow";
  if (type.startsWith("skill.") || type.startsWith("capability.")) return "autonomy";
  if (type.endsWith(".completed") || type.endsWith(".succeeded")) return "ok";
  return "flow";
}

export function toTimeline(entries: readonly AuditEntry[]): TimelineEntry[] {
  return entries
    .map((e) => ({
      id: e.id,
      at: e.occurredAt,
      type: e.eventType,
      actor: e.actor.id,
      actorKind: e.actor.kind,
      taskId: e.taskId ?? null,
      tone: auditTone(e.eventType),
    }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

export function buildCockpitSnapshot(sources: CockpitSources): CockpitSnapshot {
  const since = sources.now.getTime() - DAY_MS;
  const workers = isReal(sources.workers)
    ? buildWorkerViews(
        sources.workers.value,
        sources.activeAssignments,
        sources.attempts,
        sources.now,
        sources.workspaces,
      )
    : null;
  const missionData = isReal(sources.missions)
    ? summarizeMissions(sources.missions.value, sources.attempts)
    : null;
  const missions = missionData?.summaries ?? null;
  const alerts = [...deriveAlerts(sources, workers, missions), ...buildPipeline(sources).alerts];
  const backlog = integrationBacklog(sources.workspaces);
  const health = deriveHealth(alerts, workers);
  const recentAudit = isReal(sources.audit)
    ? sources.audit.value.filter((e) => Date.parse(e.occurredAt) >= since)
    : null;

  const fromMissions = (fn: (m: MissionSummary[]) => number, derivation: string): Truth<number> =>
    missions ? real(fn(missions), derivation) : (sources.missions as Truth<number>);

  const activeMissions = fromMissions(
    (m) => m.filter((x) => ACTIVE_MISSION.has(x.status)).length,
    "missions in planning/ready/running/blocked/awaiting approval",
  );
  const readyQueue = fromMissions(
    (m) => m.reduce((n, x) => n + x.ready, 0),
    "queued mission tasks whose dependencies all completed (BR-20)",
  );
  const activeWorkers: Truth<number> = isReal(sources.activeAssignments)
    ? real(
        new Set(sources.activeAssignments.value).size,
        "distinct workers holding a non-terminal dispatch",
      )
    : sources.activeAssignments;
  const reviewBacklog: Truth<number> = isReal(sources.tasks)
    ? real(sources.tasks.value.filter((t) => t.status === "review_pending").length)
    : sources.tasks;
  const humanInterventions: Truth<number> = recentAudit
    ? real(
        recentAudit.filter((e) => e.actor.kind === "human" && !e.eventType.startsWith("auth."))
          .length,
        "human-actor audit entries in 24h — partial proxy (BR-07)",
      )
    : (sources.audit as Truth<number>);
  const mustNow = real(alerts.filter((a) => a.severity === "P0").length, "P0 alerts");
  const telemetry = (what: string) =>
    missing<number>("not_available", `${what} is not measured by any ICOS source yet.`, "BR-04");
  const truth = sources.truth;
  const providerHealth = providerHealthMetric(sources.workers);
  const memoryMetricValue: Truth<number> = truth
    ? memoryMetric(truth.memory)
    : missing("not_available", "Durable memory exposes no health or volume metric.", "BR-02");
  const selfDevMetric: Truth<number> = truth
    ? selfDevelopmentMetric(truth.selfDevelopment)
    : missing("not_available", "Improvement candidates are not persisted.", "BR-08");
  const cost: Truth<number | string> = truth
    ? costMetric(truth.spend)
    : missing(
        "not_available",
        "No cost ledger exists; cost is never estimated in the UI.",
        "BR-05",
      );
  const tokenThroughput: Truth<number> = truth
    ? tokenThroughputMetric(truth.spend)
    : telemetry("Token throughput");

  const workerCount = workers
    ? real(workers.filter((w) => w.routable).length, "routable workers")
    : (sources.workers as Truth<number>);
  const deniedCount: Truth<number> = recentAudit
    ? real(
        recentAudit.filter((e) => e.eventType === "auth.access.denied").length,
        "denied accesses in 24h",
      )
    : (sources.audit as Truth<number>);
  const worstWorker: Tone = !workers?.length
    ? "unknown"
    : workers.some((w) => w.tone === "critical")
      ? "critical"
      : workers.some((w) => w.tone === "warn")
        ? "warn"
        : workers.some((w) => w.tone === "ok")
          ? "ok"
          : "unknown";
  const missionTone: Tone = !missions
    ? "unknown"
    : missions.some((m) => m.tone === "critical" && ACTIVE_MISSION.has(m.status))
      ? "critical"
      : missions.some((m) => m.status === "awaiting_approval")
        ? "warn"
        : missions.some((m) => m.running > 0)
          ? "ok"
          : "flow";
  const reviewN = isReal(reviewBacklog) ? reviewBacklog.value : 0;
  const readyN = isReal(readyQueue) ? readyQueue.value : 0;
  const runningN = missions?.reduce((n, m) => n + m.running, 0) ?? 0;

  const domains: SystemDomain[] = [
    {
      key: "goals",
      label: "Goals",
      tone: recentAudit ? "flow" : "unknown",
      metric: recentAudit
        ? real(
            recentAudit.filter((e) => e.eventType.startsWith("goal.")).length,
            "goal events in 24h",
          )
        : (sources.audit as Truth<number>),
      metricLabel: "events 24h",
      activity: recentAudit?.filter((e) => e.eventType.startsWith("goal.")).length ?? 0,
      href: "/cockpit/audit?eventType=goal.created",
    },
    {
      key: "missions",
      label: "Missions",
      tone: missionTone,
      metric: activeMissions,
      metricLabel: "active",
      activity: runningN,
      href: "/cockpit/missions",
    },
    {
      key: "plans",
      label: "Plans · DAG",
      tone: missions ? "flow" : "unknown",
      metric: readyQueue,
      metricLabel: "ready",
      activity: readyN,
      href: "/cockpit/missions",
    },
    {
      key: "workers",
      label: "Workers",
      tone: worstWorker,
      metric: workerCount,
      metricLabel: "routable",
      activity: isReal(activeWorkers) ? activeWorkers.value : 0,
      href: "/cockpit/workers",
    },
    {
      key: "providers",
      label: "Providers",
      tone: !isReal(providerHealth)
        ? "unknown"
        : providerHealth.value === 0
          ? "critical"
          : providerHealth.value < (isReal(sources.workers) ? sources.workers.value.length : 0)
            ? "warn"
            : "ok",
      metric: providerHealth,
      metricLabel: "routable",
      activity: isReal(providerHealth) ? providerHealth.value : 0,
      href: "/cockpit/providers",
    },
    {
      key: "memory",
      label: "Memory",
      tone: !isReal(memoryMetricValue) ? "unknown" : "ok",
      metric: memoryMetricValue,
      metricLabel: isReal(memoryMetricValue) ? "records" : "",
      activity: truth && isReal(truth.memory) ? truth.memory.value.retrievals24h : 0,
      href: "/cockpit/system",
    },
    {
      key: "security",
      label: "Security",
      tone: !isReal(deniedCount) ? "unknown" : deniedCount.value > 0 ? "warn" : "ok",
      metric: deniedCount,
      metricLabel: "denied 24h",
      activity: isReal(deniedCount) ? deniedCount.value : 0,
      href: "/cockpit/audit?eventType=auth.access.denied",
    },
    {
      key: "review",
      label: "Review",
      tone: !isReal(reviewBacklog) ? "unknown" : reviewN > 0 ? "warn" : "ok",
      metric: reviewBacklog,
      metricLabel: "pending",
      activity: reviewN,
      href: "/cockpit/missions",
    },
    {
      key: "integration",
      label: "Integration",
      tone: !isReal(backlog) ? "unknown" : backlog.value > 0 ? "warn" : "ok",
      metric: backlog,
      metricLabel: "backlog",
      activity: isReal(backlog) ? backlog.value : 0,
      href: "/cockpit/pipeline",
    },
    {
      key: "self-development",
      label: "Self-dev",
      tone: !isReal(selfDevMetric) ? "unknown" : "autonomy",
      metric: selfDevMetric,
      metricLabel: isReal(selfDevMetric) ? "candidates" : "",
      activity: isReal(selfDevMetric) ? selfDevMetric.value : 0,
      href: "/cockpit/self-development",
    },
    {
      key: "observability",
      label: "Observability",
      tone: recentAudit ? "ok" : "unknown",
      metric: recentAudit
        ? real(recentAudit.length, "audit entries in 24h")
        : (sources.audit as Truth<number>),
      metricLabel: "events 24h",
      activity: recentAudit?.length ?? 0,
      href: "/cockpit/audit",
    },
  ];

  return {
    generatedAt: sources.now.toISOString(),
    backend: sources.backend,
    scope: sources.scope,
    health,
    metrics: {
      globalHealth:
        health.level === "unknown"
          ? missing("unknown", health.reasons[0] ?? "")
          : real(health.level, "rolled up from alerts"),
      autonomyLevel: missing(
        "not_available",
        "No autonomy assessment is produced by ICOS; the level is never guessed.",
        "BR-06",
      ),
      activeMissions,
      activeWorkers,
      readyQueue,
      reviewBacklog,
      integrationBacklog: backlog,
      mustNow,
      providerHealth,
      cost,
      tokenThroughput,
      latency: telemetry("Provider latency"),
      humanInterventions,
    },
    domains,
    alerts,
    workers: workers ? real(workers) : (sources.workers as Truth<WorkerView[]>),
    missions: missions ? real(missions) : (sources.missions as Truth<MissionSummary[]>),
    focus: missionData?.focus ?? null,
    timeline: isReal(sources.audit)
      ? real(toTimeline(sources.audit.value).slice(0, 40))
      : (sources.audit as Truth<TimelineEntry[]>),
  };
}
