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
  /** Set by cleanup: the workspace is history, not current flow. */
  releasedAt: string | null;
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
        workspaces.value.filter((w) => w.releasedAt === null && BACKLOG.has(w.status)).length,
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
  // Released workspaces are history; the flow stages count only live ones.
  const live: Truth<WorkspaceFact[]> = isReal(ws)
    ? real(ws.value.filter((w) => w.releasedAt === null))
    : ws;
  const qcIn = (...states: string[]) =>
    count(qc, (j) => states.includes(j.state), "quality-control jobs");
  const wsIn = (...states: string[]) =>
    count(live, (w) => states.includes(w.status), "live (unreleased) workspaces");

  const stages = [
    stage(
      "execution",
      "Dispatched",
      count(attempts, (a) => a.state === "dispatched", "dispatched attempts of active tasks"),
      "Dispatch ledger (prepared-not-launched excluded)",
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
    stage(
      "gate",
      "Integration (ready + integrating)",
      integrationBacklog(live),
      "IntegrationGate",
      "warn",
    ),
    stage("accepted", "Accepted", wsIn("accepted"), "Applied to the integration target"),
    stage("rejected", "Rejected", wsIn("rejected"), "Gate refused; may return to work", "warn"),
    stage("blocked", "Blocked", wsIn("blocked"), "Needs recovery or a decision", "critical"),
    {
      key: "escalated",
      label: "Escalated to a human",
      count: missing<number>(
        "not_available",
        "Escalated jobs are listable (PostgresQualityControlRepository.listEscalated) but no cockpit source reads them yet: `qualityJobs` is built from listPending, which excludes them because it is also a recovery input.",
      ),
      tone: "unknown" as Tone,
      note: "Needs a human decision",
    },
    {
      key: "settlement",
      label: "Settlement",
      /*
       * Settlement IS integrated at this base (defect 36 is an ancestor of HEAD):
       * `QualityControlService.runRecoverySweep` calls `settleAccepted`, implemented by both
       * repositories. What is missing is a READABLE COUNT — it returns how many tasks it
       * settled and persists no tally — so the stage stays a stated gap rather than a zero.
       */
      count: missing<number>(
        "not_connected",
        "Per-task DAG settlement runs here (QualityControlService → settleAccepted) but publishes no readable counter, so no number is shown.",
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
  if (isReal(live)) {
    for (const w of live.value) {
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
