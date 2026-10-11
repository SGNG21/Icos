import type { AuditActor } from "@/core/contracts";
import { POLICY_VERSION } from "@/core/autonomy/execution-risk-policy";
import type { MissionRepository } from "@/server/mission/ports";
import type { AuditRepository, TaskRepository } from "@/server/repositories/ports";
import {
  RISK_GATE_DETAILS_KEY,
  findLatestRiskGatePark,
  findRiskGateApprovals,
  type RiskGateRecord,
} from "@/server/supervisor/task-risk-gate";
import { transitionTask } from "@/server/usecases/transition-task";

export interface ApproveRiskGatedTasksDeps {
  missions: Pick<MissionRepository, "listTasks" | "updateMissionTaskStatus">;
  tasks: Pick<TaskRepository, "getById" | "transition">;
  audit: Pick<AuditRepository, "query">;
}

export type ApproveRiskGatedTasksResult = {
  /** Mission task ids released back to the DAG. */
  released: string[];
  /** Mission task ids left parked, with why. */
  skipped: Array<{ missionTaskId: string; reason: string }>;
};

/**
 * A human approves the tasks the dispatch risk gate parked on a mission.
 *
 * Reuses the mission approval the owner already has (`POST /api/missions/[id]/approval`,
 * permission `approvals.decide`, operational scope checked, decider = the SESSION user). For
 * each mission task the gate parked, the canonical task goes `awaiting_approval → queued` AS
 * THAT HUMAN, through the canonical task transition; the audit entry written in the same
 * transaction carries the verdict fingerprint and policy version being approved — it IS the
 * approval record the gate looks for. The mission task then returns to `draft`, so the
 * ordinary readiness and ledger path dispatches it exactly once.
 *
 * Only tasks the gate parked are touched: a task parked by a reviewer's ESCALATE_TO_HUMAN
 * (its canonical task is not `awaiting_approval`, and no gate park is recorded) is left as it
 * was. A park recorded with no classification (fail closed on an error) has nothing a human
 * could approve, and stays parked.
 *
 * Restart-safe: a task whose canonical approval was recorded but whose mission task was not
 * yet released is released on the next call, without a second approval entry.
 */
export async function approveRiskGatedTasks(
  deps: ApproveRiskGatedTasksDeps,
  input: { missionId: string; approver: AuditActor & { kind: "human" } },
): Promise<ApproveRiskGatedTasksResult> {
  const result: ApproveRiskGatedTasksResult = { released: [], skipped: [] };
  const missionTasks = await deps.missions.listTasks(input.missionId);

  for (const missionTask of missionTasks) {
    if (missionTask.status !== "awaiting_approval") continue;

    const park = await findLatestRiskGatePark(deps.audit, missionTask.taskId);
    if (!park || park.missionTaskId !== missionTask.id) {
      result.skipped.push({ missionTaskId: missionTask.id, reason: "NOT_RISK_GATED" });
      continue;
    }
    if (!park.fingerprint || park.policyVersion !== POLICY_VERSION) {
      result.skipped.push({ missionTaskId: missionTask.id, reason: "NOTHING_APPROVABLE" });
      continue;
    }

    const canonical = await deps.tasks.getById(missionTask.taskId);
    if (canonical?.status === "awaiting_approval") {
      const approved: RiskGateRecord = {
        decision: "APPROVED",
        riskClass: park.riskClass ?? null,
        classes: park.classes ?? [],
        fingerprint: park.fingerprint,
        policyVersion: POLICY_VERSION,
        reasons: park.reasons ?? [],
        missionId: input.missionId,
        missionTaskId: missionTask.id,
      };
      const transitioned = await transitionTask(
        { tasks: deps.tasks },
        {
          taskId: canonical.id,
          to: "queued",
          audit: { actor: input.approver, details: { [RISK_GATE_DETAILS_KEY]: approved } },
        },
      );
      if (!transitioned.ok) {
        result.skipped.push({ missionTaskId: missionTask.id, reason: transitioned.reason });
        continue;
      }
    } else {
      const alreadyApproved = (await findRiskGateApprovals(deps.audit, missionTask.taskId)).some(
        ({ record }) => record.fingerprint === park.fingerprint,
      );
      if (!alreadyApproved) {
        result.skipped.push({ missionTaskId: missionTask.id, reason: "NOT_AWAITING_APPROVAL" });
        continue;
      }
    }

    await deps.missions.updateMissionTaskStatus(input.missionId, missionTask.id, "draft");
    result.released.push(missionTask.id);
  }

  return result;
}
