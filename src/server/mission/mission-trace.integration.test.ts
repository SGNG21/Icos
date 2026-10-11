import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import { runWithAttribution } from "@/server/budget/attribution-context";
import {
  ambientlyAttributed,
  ambientlyReserved,
  SPEND_LEDGER_TENANT_ID,
  UNCAPPED_OVERHEAD,
} from "@/server/budget/compose-spend";
import { PostgresSpendLedger } from "@/server/budget/postgres-spend-ledger";
import { PostgresSpendReservations } from "@/server/budget/postgres-spend-reservations";
import { createDatabase } from "@/server/database/client";
import { auditEntries } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import type { TaskExecutionDispatchInput, TaskExecutionDispatcher } from "@/server/execution/ports";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresGoalRepository } from "@/server/repositories/postgres/goal-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { TaskRiskGate } from "@/server/supervisor/task-risk-gate";
import { approveRiskGatedTasks } from "@/server/usecases/approve-risk-gated-tasks";
import {
  appendTerminalAudit,
  terminalTaskAuditEntry,
} from "@/server/repositories/postgres/terminal-transition-audit";

import { formatMissionTrace, getMissionTrace, type MissionTraceDeps } from "./mission-trace";

/**
 * DECISION + COST TRACEABILITY PER MISSION, on real PostgreSQL.
 *
 * One goal (human-approved) → a mission of two tasks: `inspect` (read-only, dispatches) and
 * `ship` (deploy, parked by the risk gate). A human releases `ship`; both execute, both are
 * reviewed and ACCEPTED by QC, the mission settles `succeeded`. The planner and the reviewer
 * "spend" through the REAL ambient-attribution seams (reservation settle + ledger record) under
 * the attribution the runner/reviewer now open: `{ goalId, missionId }`.
 *
 * Proven: every step is in the trace, in order; every TERMINAL transition (task succeeded,
 * mission succeeded, and in the second case task escalated + mission cancelled) has exactly one
 * audit row even when replayed; and the mission's cost rows are attributed to it, apart from
 * the goal's unattributed spend and another mission's.
 */
describe("mission trace (PostgreSQL)", () => {
  const handle = createDatabase(TEST_DATABASE_URL);

  afterAll(async () => {
    await handle.close();
  });

  function compose(dispatch: TaskExecutionDispatcher["dispatch"]) {
    const tasks = new PostgresTaskRepository(handle.db);
    const missions = new PostgresMissionRepository(handle.db, tasks);
    const goals = new PostgresGoalRepository(handle.db);
    const audit = new PostgresAuditRepository(handle.db);
    const dispatchAttempts = new PostgresDispatchAttemptRepository(handle.db);
    const supervisor = new SupervisorService(
      missions,
      tasks,
      { dispatch } as TaskExecutionDispatcher,
      new PostgresDurableMemory(handle.db),
      dispatchAttempts,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new TaskRiskGate({ tasks, missions, goals, audit }),
    );
    const executionResults = new PostgresTaskExecutionResultRepository(handle.db);
    const qualityControl = new PostgresQualityControlRepository(handle.db);
    const reviewDecisions = new PostgresReviewDecisionRepository(handle.db);
    const spend = new PostgresSpendLedger({
      db: handle.db,
      tenantId: SPEND_LEDGER_TENANT_ID,
      caps: UNCAPPED_OVERHEAD,
    });
    const traceDeps: MissionTraceDeps = {
      missions,
      audit,
      dispatchAttempts,
      executionResults,
      reviewDecisions,
      qualityControl,
      goals,
      spend,
    };
    return {
      tasks,
      missions,
      goals,
      audit,
      supervisor,
      dispatchAttempts,
      executionResults,
      qualityControl,
      spend,
      traceDeps,
    };
  }

  const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));

  async function seedGoalAndMission(c: ReturnType<typeof compose>, tag: string) {
    const goalId = `goal-trace-${tag}-${randomUUID().slice(0, 8)}`;
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
      metadata: { approvedBy: "owner-trace" },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await c.goals.create(goal, {
      goalId,
      missionTitle: goal.title,
      missionObjective: goal.objective,
      tasks: [],
    });
    const mission = await c.missions.create({
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
          riskClass: "reversible",
          requiredCapabilities: ["deploy"],
        },
      ] as never,
    });
    const listed = await c.missions.listTasks(mission.id);
    return {
      goalId,
      mission,
      inspect: listed.find((t) => t.title === "inspect")!,
      ship: listed.find((t) => t.title === "ship")!,
    };
  }

  /** The worker ran and reported: running → review_pending through the canonical callback store. */
  async function execute(c: ReturnType<typeof compose>, taskId: string, workflowId: string) {
    expect((await c.tasks.transition(taskId, "running")).ok).toBe(true);
    const recorded = await c.executionResults.record({
      taskId,
      workflowId,
      outcome: "success",
      workerKind: "agent",
      actualProvider: "omniroute",
      actualModel: "claude/claude-sonnet-5",
      result: "done",
      completedAt: new Date().toISOString(),
    } as never);
    expect(recorded.ok).toBe(true);
    const row = await c.executionResults.getByWorkflowId(workflowId);
    return row!;
  }

  async function reviewAndApply(
    c: ReturnType<typeof compose>,
    ids: {
      missionId: string;
      missionTaskId: string;
      taskId: string;
      workflowId: string;
      resultId: string;
    },
    action: "ACCEPT" | "ESCALATE",
  ) {
    await c.qualityControl.register({
      missionId: ids.missionId,
      missionTaskId: ids.missionTaskId,
      taskId: ids.taskId,
      workflowId: ids.workflowId,
      executionResultId: ids.resultId,
      executionAttempt: 1,
    });
    const owner = `qc-${randomUUID().slice(0, 8)}`;
    let job = await c.qualityControl.claimNext(ids.missionId, owner, 60_000);
    while (job && job.workflowId !== ids.workflowId) {
      job = await c.qualityControl.claimNext(ids.missionId, owner, 60_000);
    }
    expect(job?.workflowId).toBe(ids.workflowId);
    const review: ReviewDecisionRecord = {
      id: `review-${ids.taskId}`,
      taskId: ids.taskId,
      workflowId: ids.workflowId,
      missionId: ids.missionId,
      decision: action === "ACCEPT" ? "APPROVE" : "ESCALATE_TO_HUMAN",
      reviewerKind: "llm",
      severity: action === "ACCEPT" ? "info" : "critical",
      reasons: [action === "ACCEPT" ? "work is correct" : "needs a human"],
      providerMetadata: { provider: "omniroute", model: "codex/gpt-5.6-sol" },
      confidence: 0.9,
      humanOverridden: false,
      createdAt: new Date().toISOString(),
    };
    await c.qualityControl.saveDecision(ids.workflowId, owner, { review, action });
    await c.qualityControl.applyAction(ids.workflowId, owner, {});
    return owner;
  }

  async function terminalAudits(where: ReturnType<typeof sql>) {
    return (await handle.db.execute(sql`
      select id, event_type, task_id, mission_id, details from audit_entries
       where (details->>'terminal')::boolean is true and ${where}
    `)) as unknown as Array<Record<string, unknown>>;
  }

  it("a succeeded mission's trace holds every decision in order, one terminal audit each, and its cost", async () => {
    const c = compose(dispatch);
    const { goalId, mission, inspect, ship } = await seedGoalAndMission(c, "ok");

    /* The planner's call, metered under the attribution the runner opens ({ goalId, missionId }). */
    const reservations = ambientlyReserved(
      new PostgresSpendReservations({
        db: handle.db,
        tenantId: SPEND_LEDGER_TENANT_ID,
        caps: UNCAPPED_OVERHEAD,
      }),
    );
    await runWithAttribution({ goalId, missionId: mission.id }, async () => {
      const reserved = await reservations.reserve(null, 4_000);
      expect(reserved.kind).toBe("RESERVED");
      if (reserved.kind !== "RESERVED") return;
      await reservations.settle(reserved.reservation, {
        modelId: "claude/claude-opus-5",
        usage: {
          kind: "METERED",
          usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
        },
        at: new Date().toISOString(),
      });
    });

    /* Tick 1: inspect dispatches; ship is parked by the risk gate (no attempt). */
    await c.supervisor.run(mission.id);
    /* A human releases ship; tick 2 dispatches it. */
    const approval = await approveRiskGatedTasks(
      { missions: c.missions, tasks: c.tasks, audit: c.audit },
      { missionId: mission.id, approver: { kind: "human", id: "owner-trace" } },
    );
    expect(approval.released).toEqual([ship.id]);
    await c.missions.updateMissionStatus(mission.id, "running");
    await c.supervisor.run(mission.id);

    const attempts = await c.dispatchAttempts.listByMission(mission.id);
    expect(attempts.map((a) => a.taskId).sort()).toEqual([inspect.taskId, ship.taskId].sort());

    for (const mt of [inspect, ship]) {
      const attempt = attempts.find((a) => a.taskId === mt.taskId)!;
      const result = await execute(c, mt.taskId, attempt.workflowId);
      /* The reviewer's call, under the attribution the reviewer service opens. */
      await runWithAttribution({ goalId, missionId: mission.id }, () =>
        ambientlyAttributed(c.spend).record({
          modelId: "codex/gpt-5.6-sol",
          usage: {
            kind: "METERED",
            usage: { promptTokens: 800, completionTokens: 100, totalTokens: 900 },
          },
          attribution: null,
          at: new Date().toISOString(),
        }),
      );
      await reviewAndApply(
        c,
        {
          missionId: mission.id,
          missionTaskId: mt.id,
          taskId: mt.taskId,
          workflowId: attempt.workflowId,
          resultId: result.id,
        },
        "ACCEPT",
      );
    }

    /* Settlement, then a replayed settlement: one mission audit, never two. */
    const settled = await c.supervisor.settleIfComplete(mission.id);
    expect(settled).toMatchObject({ settled: true, status: "succeeded" });
    await c.supervisor.settleIfComplete(mission.id);
    await c.missions.updateMissionStatus(mission.id, "succeeded", { cause: "REPLAY" });

    /* Noise that must NOT be counted as this mission's cost. */
    await ambientlyAttributed(c.spend).record({
      modelId: "claude/claude-haiku-5",
      usage: {
        kind: "METERED",
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      },
      attribution: null,
      at: new Date().toISOString(),
    }); /* unattributed */
    await runWithAttribution({ goalId }, () =>
      ambientlyAttributed(c.spend).record({
        modelId: "claude/claude-haiku-5",
        usage: {
          kind: "METERED",
          usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
        },
        attribution: null,
        at: new Date().toISOString(),
      }),
    ); /* the goal's, naming no mission */
    await runWithAttribution({ goalId, missionId: `other-${mission.id}` }, () =>
      ambientlyAttributed(c.spend).record({
        modelId: "claude/claude-haiku-5",
        usage: {
          kind: "METERED",
          usage: { promptTokens: 70, completionTokens: 30, totalTokens: 100 },
        },
        attribution: null,
        at: new Date().toISOString(),
      }),
    ); /* another mission of the same goal */

    /*
     * REPLAY of a task's terminal audit, as a racing second writer would issue it: same task,
     * same terminal status, same workflow ⇒ same derived id ⇒ ON CONFLICT DO NOTHING.
     */
    const inspectAttempt = attempts.find((a) => a.taskId === inspect.taskId)!;
    await appendTerminalAudit(
      handle.db,
      terminalTaskAuditEntry({
        taskId: inspect.taskId,
        from: "review_pending",
        to: "succeeded",
        cause: "QC_ACCEPT",
        workflowId: inspectAttempt.workflowId,
        missionId: mission.id,
      }),
      mission.id,
    );

    /* ── TERMINAL AUDITS: exactly one per task and one for the mission ── */
    for (const mt of [inspect, ship]) {
      const rows = await terminalAudits(sql`task_id = ${mt.taskId}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe("task.transitioned");
      expect(rows[0]!.mission_id).toBe(mission.id);
      expect(rows[0]!.details).toMatchObject({
        from: "review_pending",
        to: "succeeded",
        outcome: "succeeded",
        cause: "QC_ACCEPT",
        qcAction: "ACCEPT",
        reviewDecisionId: `review-${mt.taskId}`,
      });
    }
    const missionRows = await terminalAudits(sql`mission_id = ${mission.id} and task_id is null`);
    expect(missionRows).toHaveLength(1);
    expect(missionRows[0]).toMatchObject({ event_type: "mission.transitioned" });
    expect(missionRows[0]!.details).toMatchObject({
      missionId: mission.id,
      goalId,
      from: "running",
      to: "succeeded",
      outcome: "succeeded",
      cause: "ALL_TASKS_SUCCEEDED",
    });

    /* ── THE TRACE ── */
    const trace = (await getMissionTrace(c.traceDeps, mission.id))!;
    expect(trace.mission).toMatchObject({ id: mission.id, status: "succeeded", goalId });
    /* No governed workspace in this composition: named as unavailable, never an empty history. */
    expect(trace.sources).toEqual({
      audit: "read",
      goal: "read",
      dispatchAttempts: "read",
      executionResults: "read",
      reviewDecisions: "read",
      qualityControl: "read",
      workspaces: "unavailable",
      spend: "read",
    });

    const kinds = trace.steps.map((s) => s.kind);
    for (const kind of [
      "goal.approval",
      "task.created",
      "risk-gate",
      "approval",
      "dispatch",
      "execution",
      "review",
      "qc",
      "task.settled",
      "mission.settled",
    ] as const) {
      expect(kinds, kind).toContain(kind);
    }
    /* Ordered: timestamps never go backwards, and the causal chain of `ship` holds. */
    const times = trace.steps.map((s) => Date.parse(s.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const shipChain = trace.steps
      .filter((s) => s.taskId === ship.taskId)
      .map((s) => s.kind)
      .filter((k) =>
        [
          "task.created",
          "risk-gate",
          "approval",
          "dispatch",
          "execution",
          "review",
          "qc",
          "task.settled",
        ].includes(k),
      );
    expect(shipChain).toEqual([
      "task.created",
      "risk-gate",
      "approval",
      "dispatch",
      "execution",
      "review",
      "qc",
      "task.settled",
    ]);
    expect(kinds.at(-1)).toBe("mission.settled");
    expect(trace.steps.filter((s) => s.kind === "task.settled")).toHaveLength(2);
    expect(trace.steps.filter((s) => s.kind === "mission.settled")).toHaveLength(1);
    expect(trace.steps.find((s) => s.kind === "approval")!.details).toMatchObject({
      actor: { kind: "human", id: "owner-trace" },
    });

    /* ── THE COST ── */
    expect("unavailable" in trace.cost).toBe(false);
    if ("unavailable" in trace.cost) return;
    const own = trace.cost.entries.filter((e) => e.scope === "mission");
    expect(own.map((e) => e.modelId).sort()).toEqual(
      ["claude/claude-opus-5", "codex/gpt-5.6-sol", "codex/gpt-5.6-sol"].sort(),
    );
    expect(own.every((e) => e.attributionKey === `goal=${goalId}`)).toBe(true);
    expect(trace.cost.total).toMatchObject({
      calls: 3,
      promptTokens: 1200 + 800 + 800,
      completionTokens: 300 + 100 + 100,
      totalTokens: 1500 + 900 + 900,
    });
    expect(trace.cost.goalShared).toMatchObject({ calls: 1, totalTokens: 50 });
    expect(trace.cost.entries.some((e) => e.totalTokens === 100 || e.totalTokens === 20)).toBe(
      false,
    );

    /* Sample output of `pnpm mission:trace <missionId>` (same formatter). */
    console.log(`MISSION_TRACE_SAMPLE\n${formatMissionTrace(trace)}`);
  });

  it("an escalated task and a cancelled mission are audited once each, through QC and the control CAS", async () => {
    const c = compose(dispatch);
    const { mission, inspect } = await seedGoalAndMission(c, "esc");
    await c.supervisor.run(mission.id);
    const attempt = (await c.dispatchAttempts.listByMission(mission.id)).find(
      (a) => a.taskId === inspect.taskId,
    )!;
    const result = await execute(c, inspect.taskId, attempt.workflowId);
    await reviewAndApply(
      c,
      {
        missionId: mission.id,
        missionTaskId: inspect.id,
        taskId: inspect.taskId,
        workflowId: attempt.workflowId,
        resultId: result.id,
      },
      "ESCALATE",
    );

    const from = (await c.missions.findById(mission.id))!.status;
    expect(
      await c.missions.transitionMissionStatusIf(mission.id, from, "cancelled", {
        cause: "CONTROL_CANCEL",
      }),
    ).toBe(true);
    /* A second cancel finds the status changed: no write, no audit. */
    expect(await c.missions.transitionMissionStatusIf(mission.id, from, "cancelled")).toBe(false);
    /* `cancelled` is sticky: a late settlement neither moves it nor audits. */
    await c.missions.updateMissionStatus(mission.id, "failed", { cause: "LATE" });

    const taskRows = await terminalAudits(sql`task_id = ${inspect.taskId}`);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]!.details).toMatchObject({
      to: "failed",
      outcome: "escalated",
      cause: "QC_ESCALATED",
    });
    const missionRows = await handle.db
      .select()
      .from(auditEntries)
      .where(
        and(
          eq(auditEntries.missionId, mission.id),
          eq(auditEntries.eventType, "mission.transitioned"),
        ),
      );
    expect(missionRows).toHaveLength(1);
    expect(missionRows[0]!.details).toMatchObject({
      to: "cancelled",
      outcome: "cancelled",
      cause: "CONTROL_CANCEL",
    });

    const trace = (await getMissionTrace(c.traceDeps, mission.id))!;
    expect(trace.mission.status).toBe("cancelled");
    expect(
      trace.steps.filter((s) => s.kind === "task.settled").map((s) => s.details.outcome),
    ).toEqual(["escalated"]);
    expect(trace.steps.at(-1)).toMatchObject({ kind: "mission.settled" });
    /* No spend was made for this mission: an EMPTY window, not an invented one. */
    expect("unavailable" in trace.cost ? null : trace.cost.total.calls).toBe(0);
  });
});
