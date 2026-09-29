import type { Alert, CockpitSources, Tone } from "./snapshot";
import { isReal, missing, real, type Truth } from "./truth";

/**
 * Execution pipeline read model: attempt → review → correction → gate → apply.
 *
 * Built only from committed canonical reads: the dispatch ledger, the quality
 * control jobs (`QualityControlRepository.listPending`) and the workspace
 * registry (`WorkspaceManager.list`), which is where the integration lifecycle
 * and workspace leases/fencing tokens live. Stages with no readable source on
 * this branch are explicit missing values.
 */

/** Structural copy of the canonical workspace, minus paths and DB names (never shown). */
export interface WorkspaceFact {
  id: string;
  slug: string;
  workerId: string;
  missionId: string | null;
  taskId: string | null;
  status: string;
  branch: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  sourceCommit: string | null;
  updatedAt: string;
}

export interface QualityFact {
  workflowId: string;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  executionAttempt: number;
  reviewAttemptCount: number;
  state: string;
  action: string | null;
  lastError: string | null;
  updatedAt: string;
}

const BACKLOG = new Set(["ready_for_integration", "integrating"]);
/** Statuses in which a workspace is expected to be held by someone. */
const LEASED = new Set(["working", "validating", "integrating"]);

export type LeaseState = "held" | "expired" | "none";

export function leaseState(w: WorkspaceFact, now: Date): LeaseState {
  if (!w.leaseOwner || !w.leaseExpiresAt) return "none";
  return Date.parse(w.leaseExpiresAt) > now.getTime() ? "held" : "expired";
}

export function integrationBacklog(workspaces: Truth<WorkspaceFact[]>): Truth<number> {
  return isReal(workspaces)
    ? real(
        workspaces.value.filter((w) => BACKLOG.has(w.status)).length,
        "workspaces ready for or in integration",
      )
    : (workspaces as Truth<number>);
}

export interface PipelineStage {
  key: string;
  label: string;
  count: Truth<number>;
  tone: Tone;
  note: string;
}

const count = <T>(t: Truth<T[]>, pred: (x: T) => boolean, derivation: string): Truth<number> =>
  isReal(t) ? real(t.value.filter(pred).length, derivation) : (t as Truth<number>);

function toneOf(n: Truth<number>, bad: Tone | null): Tone {
  if (!isReal(n)) return "unknown";
  return n.value > 0 && bad ? bad : n.value > 0 ? "flow" : "ok";
}

function stage(
  key: string,
  label: string,
  n: Truth<number>,
  note: string,
  bad: Tone | null = null,
): PipelineStage {
  return { key, label, count: n, tone: toneOf(n, bad), note };
}

export function buildPipeline(
  sources: Pick<CockpitSources, "attempts" | "qualityJobs" | "workspaces" | "now">,
): { stages: PipelineStage[]; alerts: Alert[] } {
  const { attempts, qualityJobs: qc, workspaces: ws } = sources;
  const qcIn = (...states: string[]) =>
    count(qc, (j) => states.includes(j.state), "quality-control jobs");
  const wsIn = (...states: string[]) =>
    count(ws, (w) => states.includes(w.status), "workspace registry");

  const stages = [
    stage(
      "execution",
      "Executing",
      count(attempts, () => true, "non-terminal attempts of active tasks"),
      "Dispatch ledger",
    ),
    stage("review", "Awaiting review", qcIn("review_pending", "reviewing"), "Independent review"),
    stage(
      "reviewer-outage",
      "Reviewer unavailable",
      qcIn("review_unavailable"),
      "Parked after the review budget; recoverable, never fails the result",
      "critical",
    ),
    stage(
      "decision",
      "Decision ready",
      qcIn("decision_ready"),
      "Accept / correct / retry / replan / escalate pending",
      "warn",
    ),
    stage("gate", "Integration backlog", integrationBacklog(ws), "IntegrationGate", "warn"),
    stage("accepted", "Accepted", wsIn("accepted"), "Applied to the integration target"),
    stage("rejected", "Rejected", wsIn("rejected"), "Gate refused; may return to work", "warn"),
    stage("blocked", "Blocked", wsIn("blocked"), "Needs recovery or a decision", "critical"),
    {
      key: "settlement",
      label: "Settlement",
      count: missing<number>(
        "not_connected",
        "Per-task DAG settlement is on the CORE3 defect-36 branch, not integrated here.",
        "CORE3 defect 36",
      ),
      tone: "unknown" as Tone,
      note: "Mission-level outcome is visible in Missions",
    },
    {
      key: "recovery",
      label: "Recovery activity",
      count: missing<number>(
        "not_available",
        "Recovery sweeps emit no readable runtime event yet.",
        "BR-02",
      ),
      tone: "unknown" as Tone,
      note: "Sweeper reaps expired leases and abandoned executions",
    },
  ];

  const alerts: Alert[] = [];
  const outage = stages.find((s) => s.key === "reviewer-outage")!.count;
  if (isReal(outage) && outage.value > 0)
    alerts.push({
      id: "reviewer-unavailable",
      category: "PROVIDER",
      severity: "P1",
      title: `${outage.value} result(s) parked: reviewer unavailable`,
      detail: "No review means no integration. Results are kept and recoverable.",
      href: "/cockpit/pipeline",
    });
  if (isReal(ws)) {
    for (const w of ws.value) {
      if (w.status === "blocked")
        alerts.push({
          id: `workspace-blocked-${w.id}`,
          category: "MISSION",
          severity: "P1",
          title: `Workspace ${w.slug} blocked`,
          href: "/cockpit/pipeline",
          at: w.updatedAt,
        });
      else if (LEASED.has(w.status) && leaseState(w, sources.now) === "expired")
        alerts.push({
          id: `workspace-lease-expired-${w.id}`,
          category: "RECOVERY",
          severity: "P1",
          title: `Workspace ${w.slug} is ${w.status} with an expired lease`,
          detail: "Awaiting recovery by the sweeper; the fencing token prevents a stale writer.",
          href: "/cockpit/pipeline",
          at: w.leaseExpiresAt ?? undefined,
        });
    }
  }
  return { stages, alerts };
}

