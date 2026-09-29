import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { decisions, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import {
  candidateRegistration,
  candidateWorkerId,
  classifyModels,
} from "@/server/workers/compute-fleet";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import {
  effectiveModelKey,
  reviewerEffectiveIdentity,
  writerEffectiveModel,
} from "@/core/workers/compute-routing";

/*
 * DECISION 0054 — governed compute routing against a real PostgreSQL.
 *
 * Every "restart" is a new connection handle; nothing is carried in memory between them.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "compute-mission";
const MT = "compute-mt-1";
const TASK = "compute-task-1";
const SONNET = "anthropic/claude-sonnet-5";
const SOL = "openai/gpt-5.6-sol";
const handles: DatabaseHandle[] = [];

function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const missionRepo = new PostgresMissionRepository(handle.db, taskRepo);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const router = new CapabilityRouter(store, {
    activeAssignments: () => ledger.listActiveWorkerAssignments(),
    computeHistory: (since) => ledger.listRecentComputeOutcomes(since),
    executionLeaseMs: 25 * 60_000,
    defaultBudgetMs: () => 15 * 60_000,
  });
  const dispatched: string[] = [];
  const dispatcher: TaskExecutionDispatcher = {
    dispatch: async (input) => {
      dispatched.push(input.workflowId!);
      return { workflowId: input.workflowId! };
    },
  };
  const supervisor = new SupervisorService(
    missionRepo,
    taskRepo,
    dispatcher,
    new PostgresDurableMemory(handle.db),
    ledger,
    undefined,
    router,
  );
  return {
    handle,
    ledger,
    router,
    supervisor,
    dispatched,
    registration: new WorkerRegistrationService(store),
  };
}

const seed = restart();

async function seedWorld() {
  const now = new Date();
  await seed.handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "compute",
    objective: "route compute",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(tasks).values({
    id: TASK,
    title: "Edit a file",
    description: "Edit a file",
    status: "draft",
    assignedAgentId: null,
    requiredCapabilities: ["code_editing"],
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(missionTasks).values({
    id: MT,
    missionId: MISSION_ID,
    title: "Edit a file",
    description: "Edit a file",
    dependsOn: [],
    status: "draft",
    workerKind: null,
    capability: null,
    taskId: TASK,
    createdAt: now,
    updatedAt: now,
  });
  for (const model of classifyModels([SONNET, SOL])) {
    const reg = candidateRegistration(model, {
      runtime: "binary",
      capabilities: ["code_editing", "review"],
    });
    await seed.registration.register(reg);
    await seed.registration.probe(reg.id, { health: "healthy", availability: "available" });
  }
}

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close().catch(() => {})));
});

describe("DECISION 0054 on PostgreSQL", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, decisions RESTART IDENTITY CASCADE",
      ),
    );
    await seedWorld();
  });

  it("MIGRATION 0048: the widened allow-list admits the new classes and still refuses garbage", async () => {
    const { ledger, supervisor } = restart();
    await supervisor.run(MISSION_ID);
    const attempt = (await ledger.getByWorkflowId(workflowIdForAttempt(TASK, 1)))!;
    for (const cls of ["EXECUTION_TIMEOUT", "AUTH_FAILURE", "MODEL_UNAVAILABLE"] as const) {
      await ledger.recordExecutionFailure(attempt.id, {
        failureClass: cls,
        message: cls,
        durationMs: 42,
      });
      expect((await ledger.getByWorkflowId(attempt.workflowId))?.failureClass).toBe(cls);
    }
    await expect(
      seed.handle.db.execute(
        sql.raw(
          `update dispatch_attempts set failure_class = 'NOT_A_CLASS' where id = '${attempt.id}'`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      seed.handle.db.execute(
        sql.raw(
          `update dispatch_attempts set execution_duration_ms = -1 where id = '${attempt.id}'`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("B1. A PROVIDER COOLDOWN IS BACK-PRESSURE AT FIRST DISPATCH: the task stays ready, never blocked", async () => {
    /* Both candidates' providers refused us a minute ago (rate limit), on another task. */
    const now = new Date();
    await seed.handle.db.insert(tasks).values({
      id: "other-task",
      title: "o",
      description: "o",
      status: "running",
      assignedAgentId: null,
      createdAt: now,
      updatedAt: now,
    });
    await seed.handle.db.insert(missionTasks).values({
      id: "other-mt",
      missionId: MISSION_ID,
      title: "o",
      description: "o",
      dependsOn: [],
      status: "running",
      workerKind: null,
      capability: null,
      taskId: "other-task",
      createdAt: now,
      updatedAt: now,
    });
    let n = 0;
    for (const model of [SONNET, SOL]) {
      n += 1;
      await seed.handle.db.execute(
        sql.raw(
          `insert into dispatch_attempts (id, mission_id, mission_task_id, task_id, attempt, workflow_id, prompt, worker_id, state, failure_class, created_at, updated_at)
           values ('rl-${n}', '${MISSION_ID}', 'other-mt', 'other-task', ${n}, 'rl-wf-${n}', 'x', '${candidateWorkerId(model)}', 'failed', 'RATE_LIMITED', now() - interval '1 minute', now() - interval '1 minute')`,
        ),
      );
    }

    const { supervisor, dispatched } = restart();
    await supervisor.run(MISSION_ID);
    expect(dispatched).toEqual([]);
    const mt = (await seed.handle.db.execute(
      sql.raw(`select status from mission_tasks where id = '${MT}'`),
    )) as unknown as Array<{ status: string }>;
    expect(mt[0]!.status).toBe("draft");
    const mission = (await seed.handle.db.execute(
      sql.raw(`select status from missions where id = '${MISSION_ID}'`),
    )) as unknown as Array<{ status: string }>;
    expect(mission[0]!.status).not.toBe("blocked");
  });

  it("20. THE ROUTING DECISION IS WRITTEN WITH THE ATTEMPT and survives a restart unchanged", async () => {
    const first = restart();
    await first.supervisor.run(MISSION_ID);
    expect(first.dispatched).toEqual([workflowIdForAttempt(TASK, 1)]);

    /* A different process, a new connection. */
    const later = restart();
    const attempt = (await later.ledger.getByWorkflowId(workflowIdForAttempt(TASK, 1)))!;
    const decision = attempt.routingDecision as Record<string, any>;
    expect(decision).toMatchObject({
      kind: "ROUTING_DECISION",
      role: "writer",
      policyVersion: "compute-routing/1",
    });
    expect(decision.selected.workerId).toBe(attempt.workerId);
    expect(decision.candidateSet).toHaveLength(2);
    expect(decision.lease).toEqual({ ms: 25 * 60_000, settlementMarginMs: 120_000 });
    /* Recovery re-runs the supervisor: the existing intent is NOT re-routed, the evidence stays. */
    await later.supervisor.run(MISSION_ID);
    const again = (await restart().ledger.getByWorkflowId(workflowIdForAttempt(TASK, 1)))!;
    expect(again.routingDecision).toEqual(attempt.routingDecision);
  });

  it("15. HISTORY IS READ FROM THE LEDGER: terminal attempts, with the independent verdict joined", async () => {
    const { ledger, supervisor } = restart();
    await supervisor.run(MISSION_ID);
    const attempt = (await ledger.getByWorkflowId(workflowIdForAttempt(TASK, 1)))!;
    await ledger.markDispatched(attempt.id);
    await ledger.markCompletedByWorkflowId(attempt.workflowId, 1234);
    await seed.handle.db.insert(decisions).values({
      id: "review-1",
      missionId: MISSION_ID,
      taskId: TASK,
      workflowId: attempt.workflowId,
      decision: "REQUEST_CHANGES",
      reviewerKind: "llm",
      severity: "warning",
      reasons: ["missing tests"],
      createdAt: new Date(),
    });

    const history = await restart().ledger.listRecentComputeOutcomes(new Date(Date.now() - 60_000));
    expect(history).toEqual([
      expect.objectContaining({
        workerId: attempt.workerId,
        taskId: TASK,
        attempt: 1,
        state: "completed",
        reviewVerdict: "REQUEST_CHANGES",
        durationMs: 1234,
      }),
    ]);
  });

  it("9/21. A FALLBACK RETRY ADDS A ROW: lineage kept, history untouched, and the old attempt cannot be leased again", async () => {
    const { ledger, supervisor, router } = restart();
    await supervisor.run(MISSION_ID);
    const a1 = (await ledger.getByWorkflowId(workflowIdForAttempt(TASK, 1)))!;
    await ledger.markDispatched(a1.id);
    expect(await ledger.acquireExecutionLease(a1.id, "runner-1", 60_000)).toBe(true);
    await ledger.recordExecutionFailure(a1.id, {
      failureClass: "EXECUTION_TIMEOUT",
      message: "killed",
      durationMs: 900_000,
    });

    /* Routed exactly as QC routes a retry: from the ledger's own facts. */
    const routed = await router.route(
      { requiredCapabilities: ["code_editing"] },
      {
        role: "writer",
        complexity: "medium",
        repositoryMutation: true,
        correctionAttempt: 0,
        priorAttempts: [{ attempt: 1, workerId: a1.workerId, failureClass: "EXECUTION_TIMEOUT" }],
      },
    );
    expect(routed.worker?.id).not.toBe(a1.workerId);
    expect([candidateWorkerId(SONNET), candidateWorkerId(SOL)]).toContain(routed.worker?.id);

    const a2 = await ledger.prepare({
      missionId: MISSION_ID,
      missionTaskId: MT,
      taskId: TASK,
      attempt: 2,
      workflowId: workflowIdForAttempt(TASK, 2),
      prompt: "retry",
      workerId: routed.worker!.id,
      routingDecision: routed.evidence,
    });
    expect(a2.acquired).toBe(true);

    const after = restart();
    const old = (await after.ledger.getByWorkflowId(a1.workflowId))!;
    expect(old).toMatchObject({
      state: "failed",
      failureClass: "EXECUTION_TIMEOUT",
      workerId: a1.workerId,
      executionDurationMs: 900_000,
    });
    expect(old.routingDecision).toEqual(a1.routingDecision);
    /* FENCING: the timed-out runner's attempt is terminal — no lease, so no late report. */
    expect(await after.ledger.acquireExecutionLease(a1.id, "runner-1", 60_000)).toBe(false);
    expect(await after.ledger.holdsExecutionLease(a1.id, "runner-1")).toBe(false);
    const fresh = (await after.ledger.getByWorkflowId(workflowIdForAttempt(TASK, 2)))!;
    expect(fresh.routingDecision).toMatchObject({
      previousFailure: { failureClass: "EXECUTION_TIMEOUT" },
    });
    /* A retry can never be prepared below the newest attempt: history is append-only. */
    await expect(
      after.ledger.prepare({
        missionId: MISSION_ID,
        missionTaskId: MT,
        taskId: TASK,
        attempt: 1,
        workflowId: "rewrite",
        prompt: "x",
      }),
    ).rejects.toThrow(/DISPATCH_ATTEMPT_STALE|DISPATCH_ATTEMPT_CONFLICT/);
  });

  it("WRITER/REVIEWER IDENTITY SURVIVES RESTART: the gate's inputs are resolved from durable rows", async () => {
    const first = restart();
    await first.supervisor.run(MISSION_ID);
    const attempt = (await first.ledger.getByWorkflowId(workflowIdForAttempt(TASK, 1)))!;
    /* The writer's routing evidence, made steered as the container records it. */
    await seed.handle.db.execute(
      sql.raw(
        `update dispatch_attempts set routing_decision = jsonb_set(routing_decision, '{selected,modelSteered}', 'true') where id = '${attempt.id}'`,
      ),
    );
    const writerModel = (attempt.routingDecision as any).selected.model as string;
    /* A routed reviewer that turned out to be the SAME model via another account. */
    await new PostgresReviewDecisionRepository(first.handle.db).save({
      id: "review-identity-1",
      missionId: MISSION_ID,
      taskId: TASK,
      workflowId: attempt.workflowId,
      decision: "APPROVE",
      reviewerKind: "llm",
      severity: "info",
      reasons: ["ok"],
      evidenceRefs: [],
      findingRefs: [],
      policyRefs: ["llm-review"],
      providerMetadata: {
        provider: "other-account",
        model: `other-account/${writerModel.split("/").pop()}-high`,
        routing: { kind: "ROUTING_DECISION", selected: { workerId: "reviewer-worker" } },
      },
      createdAt: new Date().toISOString(),
      humanOverridden: false,
    });

    /* A different process. */
    const later = restart();
    const decision = await new PostgresReviewDecisionRepository(later.handle.db).getByWorkflowId(
      attempt.workflowId,
    );
    const reviewer = reviewerEffectiveIdentity(decision!.providerMetadata);
    const writer = writerEffectiveModel(
      (await later.ledger.getByWorkflowId(attempt.workflowId))!.routingDecision,
    );
    expect(reviewer.workerId).toBe("reviewer-worker");
    expect(writer).toBe(writerModel);
    /* Same judge => the gate's same-model refusal fires on these persisted values. */
    expect(effectiveModelKey(reviewer.model!)).toBe(effectiveModelKey(writer!));
  });
});
