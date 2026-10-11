import type { AuditActor, AuditEntry, Task } from "@/core/contracts";
import {
  POLICY_VERSION,
  classifyTaskRisk,
  decideTaskAutonomy,
  type TaskAutonomyVerdict,
} from "@/core/autonomy/execution-risk-policy";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { MissionRepository } from "@/server/mission/ports";
import type { AuditRepository, GoalRepository, TaskRepository } from "@/server/repositories/ports";
import { transitionTask } from "@/server/usecases/transition-task";

/**
 * THE DISPATCH RISK GATE (execution-risk-policy).
 *
 * A goal that launched on policy may still be planned into a task that deploys, deletes or
 * pays: the launch-time verdict judged the goal's declared envelope, and the planner — a model
 * — chose the tasks. So before ANY attempt is prepared for a task, the supervisor asks this
 * gate, which re-derives the task's risk from the canonical Task and its goal, never from a
 * claim, and never from what the planner says is safe.
 *
 *   AUTONOMOUS / GOVERNED  → proceed unchanged.
 *   APPROVAL_REQUIRED      → the task is parked in `awaiting_approval` through the canonical
 *                            task transition (audited with class + policy version) and is
 *                            NOT dispatched — no dispatch attempt exists for it.
 *
 * A human approval releases it: `approveRiskGatedTasks` transitions the canonical task
 * `awaiting_approval → queued` AS THAT HUMAN, recording the verdict fingerprint it approved.
 * That audited transition is the approval record. It is bound to the fingerprint, so an
 * approval for one classification cannot be replayed for a different one (a changed goal, a
 * changed task, a new policy version all require a new approval). After it, the task enters
 * the ordinary ledger path, where `prepare()` is idempotent: it dispatches exactly once.
 *
 * FAIL CLOSED. Anything that prevents a classification — a missing canonical task, a goal id
 * whose goal cannot be read, a thrown error — is APPROVAL_REQUIRED.
 */

/** Where the gate's verdict lives in a `task.transitioned` audit entry's details. */
export const RISK_GATE_DETAILS_KEY = "riskGate";

export type RiskGateRecord = {
  readonly decision: "APPROVAL_REQUIRED" | "APPROVED";
  readonly riskClass: string | null;
  readonly classes: readonly string[];
  readonly fingerprint: string | null;
  readonly policyVersion: string;
  readonly reasons: readonly string[];
  readonly missionId: string;
  readonly missionTaskId: string;
};

export type RiskGateEvaluation =
  | {
      readonly outcome: "PROCEED";
      readonly verdict: TaskAutonomyVerdict;
      /** Set when a human approval is what let this task through. */
      readonly approvedBy?: string;
    }
  | {
      readonly outcome: "APPROVAL_REQUIRED";
      /** Null when no classification could be made at all. */
      readonly verdict: TaskAutonomyVerdict | null;
      readonly reasons: readonly string[];
    };

export interface TaskRiskGateDeps {
  tasks: Pick<TaskRepository, "getById" | "transition">;
  missions: Pick<MissionRepository, "updateMissionTaskStatus">;
  goals: Pick<GoalRepository, "getById">;
  audit: Pick<AuditRepository, "query">;
}

/** What a composition reports about the gate (wired into the self-model by the composition). */
export type RiskGateStatus = {
  readonly enforced: boolean;
  readonly policyVersion: string;
};

function riskGateOf(entry: AuditEntry): Partial<RiskGateRecord> | null {
  const value = (entry.details as Record<string, unknown> | undefined)?.[RISK_GATE_DETAILS_KEY];
  return value && typeof value === "object" ? (value as Partial<RiskGateRecord>) : null;
}

/** The human approvals recorded for a task, newest last. */
export async function findRiskGateApprovals(
  audit: Pick<AuditRepository, "query">,
  taskId: string,
): Promise<Array<{ entry: AuditEntry; record: Partial<RiskGateRecord> }>> {
  const entries = await audit.query({ taskId, eventType: "task.transitioned" });
  return entries
    .filter(
      (e) =>
        e.actor.kind === "human" &&
        (e.details as Record<string, unknown>).from === "awaiting_approval" &&
        (e.details as Record<string, unknown>).to === "queued",
    )
    .map((entry) => ({ entry, record: riskGateOf(entry) ?? {} }))
    .filter(({ record }) => record.decision === "APPROVED");
}

/** The latest park recorded by the gate for a task, if any. */
export async function findLatestRiskGatePark(
  audit: Pick<AuditRepository, "query">,
  taskId: string,
): Promise<Partial<RiskGateRecord> | null> {
  const entries = await audit.query({ taskId, eventType: "task.transitioned" });
  const parks = entries
    .filter((e) => (e.details as Record<string, unknown>).to === "awaiting_approval")
    .map(riskGateOf)
    .filter((r): r is Partial<RiskGateRecord> => r?.decision === "APPROVAL_REQUIRED");
  return parks.at(-1) ?? null;
}

export class TaskRiskGate {
  readonly policyVersion = POLICY_VERSION;

  constructor(private readonly deps: TaskRiskGateDeps) {}

  async evaluate(input: {
    mission: Pick<Mission, "id" | "goalId">;
    missionTask: Pick<MissionTask, "id" | "taskId" | "capability">;
    /** Pass it when already loaded; it is read here otherwise. */
    canonicalTask?: Task | null;
    /** The work will run in a governed, isolated workspace (decided by the allocation policy). */
    isolatedWorkspace: boolean;
  }): Promise<RiskGateEvaluation> {
    let verdict: TaskAutonomyVerdict;
    try {
      const canonical =
        input.canonicalTask ?? (await this.deps.tasks.getById(input.missionTask.taskId));
      if (!canonical) {
        return failClosed(`tâche canonique introuvable : ${input.missionTask.taskId}`);
      }
      const goalId = canonical.goalId ?? input.mission.goalId;
      const goal = goalId ? (await this.deps.goals.getById(goalId))?.goal : undefined;
      if (goalId && !goal) {
        return failClosed(`objectif introuvable : ${goalId}`);
      }

      const classification = classifyTaskRisk({
        capabilities: [
          ...(canonical.requiredCapabilities ?? []),
          ...(input.missionTask.capability ? [input.missionTask.capability] : []),
        ],
        /*
         * The SAME notion of "writer" as the workspace allocation policy
         * (`decideWorkspaceAllocation`): only `read_only` mutates nothing, and an absent class
         * is the canonical default `reversible`. A `read_only` task's file scope names what it
         * READS: it gets no worktree and the sandbox mounts the repository read-only, so the
         * runtime enforces that it cannot write. Counting that scope as a write made the gate
         * park every planned inspection task as an ungoverned writer (measured in the N1 lab).
         */
        repositoryWrite: (canonical.riskClass ?? "reversible") !== "read_only",
        riskLevel: canonical.riskClass,
        assertedRisk: goal?.riskLevel,
        allowedCapabilities: goal?.allowedCapabilities,
      });
      verdict = decideTaskAutonomy(classification, {
        isolatedWorkspace: input.isolatedWorkspace,
        ownerPolicy: goal?.humanApprovalPolicy,
        /*
         * The conversational launch records WHO approved the goal. Under `always` that
         * approval covers the goal's read-only and isolated reversible work only (see
         * `ownerApprovedGoal`); without it, every task is parked.
         */
        ownerApprovedGoal:
          typeof goal?.metadata?.approvedBy === "string" && goal.metadata.approvedBy.length > 0,
        /*
         * No deployment in this codebase grants unattended external changes or pre-authorizes
         * secret scopes yet, so both stay at their strict defaults here.
         */
        externalPermitted: false,
        rollbackAvailable: false,
      });

      if (verdict.decision !== "APPROVAL_REQUIRED") {
        return { outcome: "PROCEED", verdict };
      }

      const approval = (await findRiskGateApprovals(this.deps.audit, canonical.id)).find(
        ({ record }) =>
          record.fingerprint === verdict.fingerprint && record.policyVersion === POLICY_VERSION,
      );
      if (approval) {
        return { outcome: "PROCEED", verdict, approvedBy: approval.entry.actor.id };
      }
    } catch (error) {
      return failClosed(
        `classification impossible : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { outcome: "APPROVAL_REQUIRED", verdict, reasons: verdict.reasons };
  }

  /**
   * Parks a task that has NO attempt yet: canonical `draft → queued → awaiting_approval` (each
   * an audited canonical transition carrying the verdict), then the mission task. Idempotent
   * and restart-safe — it moves the canonical task only as far as it still has to go, and a
   * half-done park is completed by the next tick, because approval is never inferred from a
   * status, only from the human-attributed approval record.
   */
  async park(input: {
    missionId: string;
    missionTask: Pick<MissionTask, "id" | "taskId">;
    evaluation: Extract<RiskGateEvaluation, { outcome: "APPROVAL_REQUIRED" }>;
  }): Promise<void> {
    const record: RiskGateRecord = {
      decision: "APPROVAL_REQUIRED",
      riskClass: input.evaluation.verdict?.riskClass ?? null,
      classes: input.evaluation.verdict?.classes ?? [],
      fingerprint: input.evaluation.verdict?.fingerprint ?? null,
      policyVersion: POLICY_VERSION,
      reasons: input.evaluation.reasons,
      missionId: input.missionId,
      missionTaskId: input.missionTask.id,
    };
    const audit = {
      actor: { kind: "system", id: "icos-risk-gate" } satisfies AuditActor,
      details: { [RISK_GATE_DETAILS_KEY]: record },
    };

    const canonical = await this.deps.tasks.getById(input.missionTask.taskId);
    if (canonical?.status === "draft") {
      await this.mustTransition(canonical.id, "queued", audit);
    }
    const current = canonical?.status === "draft" ? "queued" : canonical?.status;
    if (current === "queued") {
      await this.mustTransition(input.missionTask.taskId, "awaiting_approval", audit);
    }
    await this.deps.missions.updateMissionTaskStatus(
      input.missionId,
      input.missionTask.id,
      "awaiting_approval",
    );
  }

  private async mustTransition(
    taskId: string,
    to: "queued" | "awaiting_approval",
    audit: { actor: AuditActor; details: Record<string, unknown> },
  ): Promise<void> {
    const result = await transitionTask({ tasks: this.deps.tasks }, { taskId, to, audit });
    if (!result.ok && result.reason !== "invalid_transition") {
      throw new Error(`RISK_GATE_PARK_FAILED: ${result.reason}: ${result.message}`);
    }
    if (!result.ok) {
      /* A concurrent writer moved it; re-read and accept only the state we were heading to. */
      const now = await this.deps.tasks.getById(taskId);
      if (now?.status !== to && now?.status !== "awaiting_approval") {
        throw new Error(`RISK_GATE_PARK_FAILED: ${taskId} is ${now?.status ?? "missing"}`);
      }
    }
  }
}

function failClosed(reason: string): RiskGateEvaluation {
  return { outcome: "APPROVAL_REQUIRED", verdict: null, reasons: [reason] };
}
