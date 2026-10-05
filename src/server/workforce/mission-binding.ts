import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import type { MissionTask } from "@/core/mission/contracts";

import type { ChiefDelegation, ChiefDelegationOutcome } from "./chief-delegation";
import type { BrainComputeNeed, WorkforceTaskCompute } from "./core3-task-compute";

/**
 * THE ONE BRIDGE between planning identity, CORE3 task identity and brain assignment
 * (decision 0070).
 *
 * Chief used to delegate at ignition, BEFORE the planner ran, so its assignments could only
 * name STAGES (`<mission>:research`) — and CORE3's dispatcher matches on the durable task
 * id (`task-…`), so no live dispatch was ever influenced by a brain. Twelve certified,
 * governed rows and zero effect.
 *
 * This decorator binds LAZILY, at the first routing of any task of a mission: it reads the
 * mission and its tasks as CORE3 persisted them, loads the goal, and asks Chief to delegate
 * per task. The assignment then carries the CORE3 task id, which is the only thing the
 * inner `forTask` matches on. No new mapping authority: Chief still plans, the workforce
 * still records, the dispatcher still reads — the three just agree on one identity.
 *
 * Properties, and where each is enforced:
 *  - durable: the binding IS the `workforce_assignments` row (task_id = CORE3 task id);
 *  - idempotent: Chief skips a (task, brain) that already has a live assignment, and a
 *    per-process fingerprint of the task set skips the whole read when nothing changed;
 *  - retry/resume-safe: a correction attempt or a restart reads the same row;
 *  - replan-aware: a new task set changes the fingerprint and new tasks get bound; tasks
 *    that vanished keep their assignment until the mission's release cancels it;
 *  - spoof-proof: nothing here reads a brain id from a plan, a prompt or a request —
 *    the brain comes from Chief's policy and the workforce's governance only;
 *  - never fatal: a delegation failure is reported and the dispatch proceeds undelegated,
 *    exactly as a mission without a goal does.
 */
export interface MissionBindingDeps {
  readonly missions: {
    findById(id: string): Promise<{ id: string; goalId?: string } | null>;
    listTasks(missionId: string): Promise<readonly Pick<MissionTask, "taskId" | "capability">[]>;
  };
  readonly goals: { getById(goalId: string): Promise<{ goal: HighLevelGoal } | null> };
  readonly chief: ChiefDelegation;
  /** Structured operator log. Default: `console.error` of one JSON line. */
  readonly report?: (event: Record<string, unknown>) => void;
}

export interface BoundTaskCompute extends WorkforceTaskCompute {
  /** Bind (or re-bind after a replan) every task of the mission. Idempotent. */
  ensureDelegated(missionId: string): Promise<ChiefDelegationOutcome | null>;
}

const fingerprintOf = (tasks: readonly { taskId: string }[]) =>
  tasks
    .map((t) => t.taskId)
    .sort()
    .join("|");

export function boundTaskCompute(
  inner: WorkforceTaskCompute,
  deps: MissionBindingDeps,
): BoundTaskCompute {
  const report = deps.report ?? ((e) => console.error(JSON.stringify(e)));
  /* ponytail: per-process memo; the durable guard is Chief's own idempotency. */
  const bound = new Map<string, string>();

  async function ensureDelegated(missionId: string): Promise<ChiefDelegationOutcome | null> {
    const mission = await deps.missions.findById(missionId);
    if (!mission?.goalId) return null;
    const tasks = await deps.missions.listTasks(missionId);
    const fingerprint = fingerprintOf(tasks);
    if (bound.get(missionId) === fingerprint) return null;
    const record = await deps.goals.getById(mission.goalId);
    if (!record) return null;

    const outcome = await deps.chief.delegateGoal(record.goal, missionId, tasks);
    if (!outcome.ok) {
      /*
       * NOT swallowed, NOT fatal. Chief declining is a decision the operator must be able to
       * read, and losing it must not strand a goal the owner asked for: the mission proceeds
       * undelegated, as before this bridge existed.
       */
      report({
        event: "CHIEF_DELEGATION_REFUSED",
        missionId,
        goalId: mission.goalId,
        refusals: outcome.refusals,
      });
      bound.set(missionId, fingerprint);
      return outcome;
    }
    if (outcome.gaps.length > 0 || outcome.unbound.length > 0) {
      /* A PARTIAL delegation is not a success; the gaps carry who was refused and why. */
      report({
        event: "CHIEF_DELEGATION_PARTIAL",
        missionId,
        goalId: mission.goalId,
        assignmentsCreated: outcome.assignments.length,
        alreadyBound: outcome.alreadyBound,
        unboundTasks: outcome.unbound.map((t) => t.taskId),
        gaps: outcome.gaps.map((g) => ({
          taskId: g.request.taskId,
          brainId: g.request.requiredAgentId ?? null,
          reason: g.reason,
          rejected: g.rejected.map((r) => ({ agentId: r.agentId, violations: r.violations })),
        })),
      });
    }
    bound.set(missionId, fingerprint);
    return outcome;
  }

  return {
    ensureDelegated,
    async forTask(missionId, taskId): Promise<BrainComputeNeed | null> {
      try {
        await ensureDelegated(missionId);
      } catch (error) {
        report({
          event: "CHIEF_DELEGATION_FAILED",
          missionId,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return inner.forTask(missionId, taskId);
    },
  };
}
