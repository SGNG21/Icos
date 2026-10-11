import {
  assessAutonomy,
  read,
  unavailable,
  type AutonomyAssessment,
  type AutonomyEvidence,
  type EvidenceRef,
  type RuntimeTier,
  type SourceRead,
} from "@/core/autonomy/assessment";
import type { AuditEntry } from "@/core/contracts/audit";
import type { MissionRepository } from "@/server/mission/ports";
import type { AuditRepository, GoalRepository } from "@/server/repositories/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import { GATE_REPORT_EVENT } from "@/server/workspace-manager/report";

/**
 * AUTONOMY EVIDENCE READER (BR-06) — the only place the assessment touches ICOS.
 *
 * Every proof below is a row another authority already writes for its own reasons: CORE3's
 * goal conversion, the execution callback, the reviewers, the integration gate, the goal
 * repository. Nothing is written, nothing is sampled, nothing is inferred from in-memory
 * state. Each source is read in isolation: one unreadable table makes ITS dimension UNKNOWN
 * and leaves the others measured.
 */
export interface AutonomyEvidenceDeps {
  readonly audit: Pick<AuditRepository, "query">;
  readonly goals: Pick<GoalRepository, "list">;
  readonly missions: Pick<MissionRepository, "list" | "listTasks">;
  readonly reviewDecisions: Pick<ReviewDecisionRepository, "list">;
}

export interface AutonomyAssessmentPort {
  current(): Promise<AutonomyAssessment>;
}

/** Newest entries are the interesting ones; the audit journal is read in ascending order. */
const SCAN_LIMIT = 500;
const SELF_DEVELOPMENT_SOURCE = "self-development";

const tail = <T>(items: readonly T[]): readonly T[] =>
  items.length > SCAN_LIMIT ? items.slice(items.length - SCAN_LIMIT) : items;

async function source<T>(
  label: string,
  fn: () => Promise<readonly T[]>,
): Promise<SourceRead<readonly T[]>> {
  try {
    return read(await fn());
  } catch {
    // The error text may carry internals; the assessment only states the fact.
    return unavailable(`${label} could not be read from ICOS.`);
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function auditRef(entry: AuditEntry, summary: string): EvidenceRef {
  return { source: "audit_entries", ref: entry.id, at: entry.occurredAt, summary };
}

export async function readAutonomyEvidence(
  deps: AutonomyEvidenceDeps,
  tier: RuntimeTier | undefined,
): Promise<AutonomyEvidence> {
  const [planned, executions, reviewed, integrated, goals] = await Promise.all([
    /* PLANNING: ICOS converted a goal into a mission and planned at least one task itself. */
    source("Goal conversions", async () => {
      const converted = tail(await deps.audit.query({ eventType: "goal.converted" }));
      const out: EvidenceRef[] = [];
      const seen = new Set<string>();
      for (const entry of converted) {
        if (entry.actor.kind === "human") continue;
        const missionId = str(entry.details.missionId);
        if (!missionId || seen.has(missionId)) continue;
        seen.add(missionId);
        const tasks = await deps.missions.listTasks(missionId);
        if (tasks.length === 0) continue;
        out.push(
          auditRef(
            entry,
            `goal ${str(entry.details.goalId) ?? "?"} → mission ${missionId}, ${tasks.length} task(s) planned by ${entry.actor.kind}`,
          ),
        );
      }
      return out;
    }),
    /* ROUTING + RECOVERY share one source: the execution callback, one row per completed run. */
    source("Execution callbacks", async () =>
      tail(await deps.audit.query({ eventType: "task.execution.completed" })).filter(
        (e) => e.actor.kind !== "human",
      ),
    ),
    /* REVIEW: a verdict by an ICOS reviewer (deterministic or LLM), never a human. */
    source("Review decisions", async () =>
      (await deps.reviewDecisions.list())
        .filter((r) => r.reviewerKind === "llm" || r.reviewerKind === "deterministic")
        .map<EvidenceRef>((r) => ({
          source: "review_decisions",
          ref: r.id,
          at: r.createdAt,
          summary: `review ${r.decision} by ${r.reviewerKind}${r.providerMetadata?.model ? ` (${r.providerMetadata.model})` : ""} on mission ${r.missionId}`,
        })),
    ),
    /* INTEGRATION: the gate's durable report, and only when it ACCEPTED. */
    source("Gate reports", async () =>
      tail(await deps.audit.query({ eventType: GATE_REPORT_EVENT }))
        .filter((e) => {
          const report = e.details.report;
          return (
            typeof report === "object" &&
            report !== null &&
            (report as { decision?: unknown }).decision === "ACCEPT"
          );
        })
        .map((e) => {
          const report = e.details.report as { commitSha?: unknown; branch?: unknown };
          return auditRef(
            e,
            `gate ACCEPT ${str(report.branch) ?? ""} @${(str(report.commitSha) ?? "").slice(0, 10)} (mission ${str(e.details.missionId) ?? "manual"})`,
          );
        }),
    ),
    /* SELF-DEVELOPMENT: goals ICOS proposed to itself (provenance in goal metadata). */
    source("Goals", async () =>
      (await deps.goals.list({ limit: SCAN_LIMIT })).filter(
        (g) => g.goal.metadata?.source === SELF_DEVELOPMENT_SOURCE,
      ),
    ),
  ]);

  const routed: SourceRead<readonly EvidenceRef[]> =
    executions.kind === "read"
      ? read(
          executions.value
            .filter((e) => e.details.outcome === "success")
            .map((e) =>
              auditRef(
                e,
                `execution success, task ${e.taskId ?? "?"} (workflow ${str(e.details.workflowId) ?? "?"})`,
              ),
            ),
        )
      : executions;

  const recovered: SourceRead<readonly EvidenceRef[]> =
    executions.kind === "read" ? read(recoveries(executions.value)) : executions;

  let selfProposed: SourceRead<readonly EvidenceRef[]>;
  let selfDeveloped: SourceRead<readonly EvidenceRef[]>;
  if (goals.kind === "read") {
    selfProposed = read(
      goals.value.map<EvidenceRef>((g) => ({
        source: "goals",
        ref: g.goal.id,
        at: g.goal.createdAt,
        summary: `self-development goal "${g.goal.title}" [${g.status}]`,
      })),
    );
    selfDeveloped = await source("Missions", async () => {
      const completed = new Map(
        (await deps.missions.list({ status: "succeeded" })).map((m) => [m.id, m]),
      );
      return goals.value
        .filter((g) => g.resultingMissionId && completed.has(g.resultingMissionId))
        .map<EvidenceRef>((g) => {
          const m = completed.get(g.resultingMissionId!)!;
          return {
            source: "missions",
            ref: m.id,
            at: m.updatedAt.toISOString(),
            summary: `self-development goal "${g.goal.title}" → mission ${m.id} succeeded`,
          };
        });
    });
  } else {
    selfProposed = goals;
    selfDeveloped = goals;
  }

  return { tier, planned, routed, recovered, reviewed, integrated, selfProposed, selfDeveloped };
}

/**
 * Recovery proof: on ONE task, a failed execution followed by a successful one. The journal is
 * ascending, so the first success after a failure on the same task is the recovery.
 */
function recoveries(executions: readonly AuditEntry[]): EvidenceRef[] {
  const failedTasks = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const e of executions) {
    const taskId = e.taskId ?? str(e.details.taskId);
    if (!taskId) continue;
    if (e.details.outcome === "failure") {
      failedTasks.add(taskId);
    } else if (e.details.outcome === "success" && failedTasks.has(taskId)) {
      failedTasks.delete(taskId);
      out.push(auditRef(e, `task ${taskId} completed after a failed execution`));
    }
  }
  return out;
}

export function autonomyAssessmentFor(
  deps: AutonomyEvidenceDeps,
  tier: RuntimeTier | undefined,
  now: () => Date = () => new Date(),
): AutonomyAssessmentPort {
  return {
    current: async () => assessAutonomy(await readAutonomyEvidence(deps, tier), now()),
  };
}
