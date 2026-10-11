import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import { POLICY_VERSION } from "@/core/autonomy/execution-risk-policy";
import { classifyMissionAutonomy } from "@/core/autonomy/mission-autonomy-policy";
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { createDatabase } from "@/server/database/client";
import { auditEntries, dispatchAttempts } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import type { TaskExecutionDispatchInput, TaskExecutionDispatcher } from "@/server/execution/ports";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresGoalRepository } from "@/server/repositories/postgres/goal-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { TaskRiskGate } from "@/server/supervisor/task-risk-gate";
import { approveRiskGatedTasks } from "@/server/usecases/approve-risk-gated-tasks";

/**
 * THE DISPATCH RISK GATE ON REAL POSTGRES.
 *
 * A goal that launched ON POLICY (if_risky, AUTO_ALLOWED envelope) is planned into one
 * read-only task and one deploy task. The read-only task dispatches; the deploy task is parked
 * in `awaiting_approval` with NO dispatch_attempts row. After a human approval it dispatches
 * exactly once, even under concurrent and repeated supervisor ticks.
 */
describe("dispatch risk gate (PostgreSQL)", () => {
  const handleA = createDatabase(TEST_DATABASE_URL);
  const handleB = createDatabase(TEST_DATABASE_URL);

  afterAll(async () => {
    await handleA.close();
    await handleB.close();
  });

  function compose(handle: typeof handleA, dispatch: TaskExecutionDispatcher["dispatch"]) {
    const tasks = new PostgresTaskRepository(handle.db);
    const missions = new PostgresMissionRepository(handle.db, tasks);
    const goals = new PostgresGoalRepository(handle.db);
    const audit = new PostgresAuditRepository(handle.db);
    const supervisor = new SupervisorService(
      missions,
      tasks,
      { dispatch } as TaskExecutionDispatcher,
      new PostgresDurableMemory(handle.db),
      new PostgresDispatchAttemptRepository(handle.db),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new TaskRiskGate({ tasks, missions, goals, audit }),
    );
    return { tasks, missions, goals, audit, supervisor };
  }

  it("parks the deploy task with no attempt, then dispatches it exactly once after approval", async () => {
    const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
      workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
    }));
    const a = compose(handleA, dispatch);
    const b = compose(handleB, dispatch);

    const goalId = `goal-risk-${randomUUID().slice(0, 8)}`;
    const goal: HighLevelGoal = {
      id: goalId,
      title: "Inspect and ship",
      objective: "Inspect the service, then ship it",
      rawInput: "Inspect the service, then ship it",
      normalizedIntent: "inspect and ship",
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      allowedCapabilities: ["research", "code_write"],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    /* This is what "launched on policy" means: the envelope is AUTO_ALLOWED at launch. */
    expect(classifyMissionAutonomy({ capabilities: goal.allowedCapabilities }).policyClass).toBe(
      "AUTO_ALLOWED",
    );
    await a.goals.create(goal, {
      goalId,
      missionTitle: goal.title,
      missionObjective: goal.objective,
      tasks: [],
    });

    const mission = await a.missions.create({
      title: goal.title,
      objective: goal.objective,
      goalId,
      tasks: [
        {
          title: "inspect",
          description: "Inspect the service",
          dependsOn: [],
          workerKind: "agent",
          riskClass: "read_only",
        },
        {
          title: "ship",
          description: "Deploy the service",
          dependsOn: [],
          workerKind: "agent",
          /* The planner calls it merely reversible; the capability decides. */
          riskClass: "reversible",
          requiredCapabilities: ["deploy"],
        },
      ] as never,
    });
    const missionTasks = await a.missions.listTasks(mission.id);
    const inspect = missionTasks.find((t) => t.title === "inspect")!;
    const ship = missionTasks.find((t) => t.title === "ship")!;
    const attemptRows = (missionTaskId: string) =>
      handleA.db
        .select()
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.missionTaskId, missionTaskId));
    const shipDispatches = () =>
      dispatch.mock.calls.filter(([input]) => input.taskId === ship.taskId).length;

    /* Tick 1: the read-only task dispatches; the deploy task is parked with no attempt. */
    await a.supervisor.run(mission.id);

    expect(dispatch.mock.calls.map(([input]) => input.taskId)).toEqual([inspect.taskId]);
    expect(await attemptRows(inspect.id)).toHaveLength(1);
    expect(await attemptRows(ship.id)).toHaveLength(0);
    expect((await a.missions.getMissionTaskById(ship.id))?.status).toBe("awaiting_approval");
    expect((await a.tasks.getById(ship.taskId))?.status).toBe("awaiting_approval");
    expect((await a.missions.findById(mission.id))?.status).toBe("awaiting_approval");

    const parkRows = await handleA.db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.taskId, ship.taskId), eq(auditEntries.eventType, "task.transitioned")));
    const park = parkRows.find(
      (r) => (r.details as Record<string, unknown>).to === "awaiting_approval",
    );
    expect(park?.actorLabel).toBe("icos-risk-gate");
    expect((park?.details as { riskGate: Record<string, unknown> }).riskGate).toMatchObject({
      decision: "APPROVAL_REQUIRED",
      riskClass: "IRREVERSIBLE",
      policyVersion: POLICY_VERSION,
    });

    /* Duplicate ticks before approval: still parked, still no attempt, never dispatched. */
    await Promise.all([a.supervisor.run(mission.id), b.supervisor.run(mission.id)]);
    expect(await attemptRows(ship.id)).toHaveLength(0);
    expect(shipDispatches()).toBe(0);

    /* A human approves (the mission approval route calls exactly this, as the session user). */
    const approval = await approveRiskGatedTasks(
      { missions: a.missions, tasks: a.tasks, audit: a.audit },
      { missionId: mission.id, approver: { kind: "human", id: "owner-risk-gate" } },
    );
    expect(approval.released).toEqual([ship.id]);
    await a.missions.updateMissionStatus(mission.id, "running");

    /* Concurrent and repeated ticks after approval: exactly one dispatch. */
    await Promise.all([a.supervisor.run(mission.id), b.supervisor.run(mission.id)]);
    await a.supervisor.run(mission.id);
    await b.supervisor.run(mission.id);

    expect(shipDispatches()).toBe(1);
    const shipAttempts = await attemptRows(ship.id);
    expect(shipAttempts).toHaveLength(1);
    expect(shipAttempts[0]?.state).toBe("dispatched");
    /* The read-only task was never dispatched twice either. */
    expect(dispatch.mock.calls.filter(([input]) => input.taskId === inspect.taskId)).toHaveLength(1);

    const approvalRows = await handleA.db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.taskId, ship.taskId), eq(auditEntries.eventType, "task.transitioned")));
    const approvalRow = approvalRows.find(
      (r) =>
        (r.details as Record<string, unknown>).from === "awaiting_approval" &&
        (r.details as Record<string, unknown>).to === "queued",
    );
    expect(approvalRow?.actorType).toBe("human");
    expect(approvalRow?.actorLabel).toBe("owner-risk-gate");
    expect((approvalRow?.details as { riskGate: Record<string, unknown> }).riskGate).toMatchObject({
      decision: "APPROVED",
      riskClass: "IRREVERSIBLE",
      policyVersion: POLICY_VERSION,
    });
  });
});
