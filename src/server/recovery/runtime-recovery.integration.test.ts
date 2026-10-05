import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import type { WorkflowProbe, WorkflowStatus } from "@/core/contracts/recovery";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import { PostgresAutonomousMissionRuntimeRepository } from "@/server/repositories/postgres/autonomous-mission-runtime-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import { FakeReviewer } from "@/server/review/fake-reviewer";
import type { ReviewInput } from "@/server/review/ports";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { startAutonomousMission } from "@/server/usecases/start-autonomous-mission";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";
import { AutonomyRecoverySweeper } from "@/server/autonomy/autonomy-recovery-sweeper";
import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";
import { CombinedAutonomyRecoverySweeper } from "@/server/autonomy/combined-autonomy-recovery-sweeper";
import { FixedPlanPlanner } from "@/server/usecases/phase6-e2e-harness";
import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "@/server/execution/ports";
import { composeRuntimeRecovery } from "@/server/recovery/compose-runtime-recovery";

/**
 * Phase 7C — crash / restart / recovery sur PostgreSQL RÉEL (base dédiée `icos_test_7c`).
 *
 * « Kill » = on abandonne la pile de services (repositories, services) sans aucun nettoyage ; « restart » =
 * une NOUVELLE pile (nouveau pool de connexions) sur la même base. Seul Temporal est simulé — avec la
 * sémantique réelle REJECT_DUPLICATE / USE_EXISTING : un même workflowId ne démarre jamais deux workflows.
 * La chaîne de sweepers est composée comme en production (`production-services.ts`).
 *
 * `ICOS_7C_DISABLED=1` désactive le sweeper 7C : sert à démontrer le RED (les trous existaient).
 */
const DISABLED_7C = process.env.ICOS_7C_DISABLED === "1";

class FakeTemporal implements TaskExecutionDispatcher, WorkflowProbe {
  readonly started = new Map<string, WorkflowStatus>();
  readonly dispatchCalls: string[] = [];
  /** Le « process » meurt APRÈS que Temporal a accepté le workflow, AVANT toute confirmation ICOS. */
  crashAfterAcceptOnce = false;
  /** Le « process » meurt AVANT que Temporal n'ait vu la requête. */
  crashBeforeAcceptOnce = false;

  async dispatch(input: TaskExecutionDispatchInput): Promise<TaskExecutionDispatchResult> {
    const workflowId = input.workflowId ?? `icos-task-${input.taskId}`;
    this.dispatchCalls.push(workflowId);
    if (this.crashBeforeAcceptOnce) {
      this.crashBeforeAcceptOnce = false;
      throw new Error("SIMULATED_KILL");
    }
    if (!this.started.has(workflowId)) this.started.set(workflowId, "running");
    if (this.crashAfterAcceptOnce) {
      this.crashAfterAcceptOnce = false;
      throw new Error("SIMULATED_KILL");
    }
    return { workflowId };
  }

  async status(workflowId: string): Promise<WorkflowStatus> {
    return this.started.get(workflowId) ?? "not_found";
  }

  callsFor(workflowId: string): number {
    return this.dispatchCalls.filter((id) => id === workflowId).length;
  }
}

class CountingReviewer extends FakeReviewer {
  calls = 0;
  override async review(input: ReviewInput) {
    this.calls += 1;
    return super.review(input);
  }
}

const plan = (...keys: string[]) => ({
  version: 1 as const,
  tasks: keys.map((key, index) => ({
    key,
    title: `Task ${key}`,
    description: `Do ${key}`,
    dependsOn: index === 0 ? [] : [keys[index - 1]],
    workerKind: "hermes" as const,
  })),
});

describe("Phase 7C — crash/restart recovery (PostgreSQL, icos_test_7c)", () => {
  const handles: DatabaseHandle[] = [];
  const temporal = new FakeTemporal();
  const llm = new CountingReviewer({ defaultResponse: { decision: "APPROVE", reasons: ["ok"] } });
  const admin = createDatabase(TEST_DATABASE_URL);

  afterAll(async () => {
    await admin.close();
  });

  beforeEach(async () => {
    temporal.started.clear();
    temporal.dispatchCalls.length = 0;
    llm.calls = 0;
    await admin.db.execute(
      sql.raw(
        "TRUNCATE TABLE recovery_units, quality_control_jobs, decisions, task_execution_results, " +
          "dispatch_attempts, autonomous_mission_runtime, mission_tasks, missions, tasks " +
          "RESTART IDENTITY CASCADE",
      ),
    );
  });

  afterEach(async () => {
    while (handles.length) await handles.pop()!.close();
  });

  /** Une « incarnation » du process : pile neuve (nouveau pool) sur la même base. */
  function boot(planner = new FixedPlanPlanner([plan("a")])) {
    const handle = createDatabase(TEST_DATABASE_URL, { max: 4 });
    handles.push(handle);
    const { db } = handle;
    const tasks = new PostgresTaskRepository(db);
    const missions = new PostgresMissionRepository(db, tasks);
    const dispatchAttempts = new PostgresDispatchAttemptRepository(db);
    const executionResults = new PostgresTaskExecutionResultRepository(db);
    const reviewDecisions = new PostgresReviewDecisionRepository(db);
    const runtime = new PostgresAutonomousMissionRuntimeRepository(db);
    const durableMemory = new PostgresDurableMemory(db);
    const qualityJobs = new PostgresQualityControlRepository(db);
    const reviewer = new ReviewerServiceImpl(llm, new DeterministicReviewer(), reviewDecisions);
    const supervisor = new SupervisorService(
      missions,
      tasks,
      temporal,
      durableMemory,
      dispatchAttempts,
    );
    const qc = new QualityControlService({
      missions,
      tasks,
      executionResults,
      reviewer,
      reviewDecisions,
      dispatchAttempts,
      qualityJobs,
      dispatchPrepared: async (prepared, signal) => {
        const result = await temporal.dispatch({
          missionId: prepared.missionId,
          taskId: prepared.taskId,
          prompt: prepared.prompt,
          workflowId: prepared.workflowId,
          signal,
        });
        if (result.workflowId !== prepared.workflowId) throw new Error("ACK_MISMATCH");
        await dispatchAttempts.markDispatched(prepared.id, { owner: "test-owner", leaseMs: 60_000 });
      },
    });
    const wakeup = new AutonomyWakeupService(missions, supervisor, runtime, undefined, planner);
    const recovery7c = composeRuntimeRecovery({
      db,
      wakeup,
      supervisor,
      dispatcher: temporal,
      missions,
      executionResults,
      dispatchAttempts,
      probe: temporal,
      options: { graceMs: 0, orphanAfterMs: 0, backoffBaseMs: 0 },
    });
    const existing = new CombinedAutonomyRecoverySweeper(
      new AutonomyRecoverySweeper(runtime, wakeup),
      new QualityControlRecoverySweeper(qc, qualityJobs, (id) => wakeup.wake(id)),
    );

    return {
      db,
      tasks,
      missions,
      dispatchAttempts,
      executionResults,
      runtime,
      qualityJobs,
      supervisor,
      qc,
      wakeup,
      recovery7c,
      planner,
      /** Un tick de la chaîne de production : sweepers existants, puis sweeper 7C. */
      async tick() {
        const before = await existing.sweep();
        const after = DISABLED_7C ? null : await recovery7c.sweep();
        return { before, after };
      },
      async ignite(): Promise<string> {
        const mission = await missions.create({ title: "M", objective: "obj", tasks: [] });
        await startAutonomousMission(
          { missions, runtimeRepository: runtime, supervisor, planner },
          { missionId: mission.id },
        );
        return mission.id;
      },
      /** Callback de complétion comme la route de production : `recordTaskExecution` seul (aucun QC inline). */
      async callback(workflowId: string, outcome: "success" | "failure" = "success") {
        const attempt = (await dispatchAttempts.getByWorkflowId(workflowId))!;
        return recordTaskExecution(
          { tasks, executionResults, supervisor, missions, durableMemory, dispatchAttempts },
          {
            taskId: attempt.taskId,
            workflowId,
            outcome,
            ...(outcome === "success"
              ? { result: "Worker output" }
              : { error: { code: "WORKER_UNAVAILABLE" as const, message: "down" } }),
            completedAt: new Date().toISOString(),
          },
        );
      },
    };
  }
  type Stack = ReturnType<typeof boot>;

  const missionStatus = async (s: Stack, id: string) => (await s.missions.findById(id))?.status;
  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await admin.db.execute(query)) as unknown as T[];
  const ageResults = () =>
    admin.db.execute(
      sql`update task_execution_results set recorded_at = now() - interval '1 hour'`,
    );
  const killRuntimeOwner = (missionId: string) =>
    admin.db.execute(sql`update autonomous_mission_runtime
      set state = 'running', owner_token = 'dead-process', lease_until = now() - interval '1 minute'
      where mission_id = ${missionId}`);
  const workflowOf = async (s: Stack, missionId: string, key: string) => {
    const task = (await s.missions.listTasks(missionId)).find((t) => t.title === `Task ${key}`)!;
    return `icos-task-${task.taskId}`;
  };
  const count = async (query: ReturnType<typeof sql>) =>
    Number((await rows<{ n: string }>(query))[0].n);

  /** Invariants globaux 9/10/11 : aucun doublon de workflow, de callback logique, d'action QC. */
  async function expectNoDuplicates() {
    // 9 — Temporal : un seul workflow par workflowId, quel que soit le nombre de re-dispatch.
    const attemptIds = await rows<{ workflow_id: string }>(
      sql`select workflow_id from dispatch_attempts`,
    );
    for (const { workflow_id } of attemptIds) {
      expect(
        [...temporal.started.keys()].filter((id) => id === workflow_id).length,
      ).toBeLessThanOrEqual(1);
    }
    expect(new Set(attemptIds.map((a) => a.workflow_id)).size).toBe(attemptIds.length);
    // 10 — callback logique : un seul `task.execution.completed` d'audit par workflow.
    const dup = await rows(sql`select details->>'workflowId' as wf from audit_entries
      where event_type = 'task.execution.completed' group by 1 having count(*) > 1`);
    expect(dup).toHaveLength(0);
    // 11 — action QC : au plus un job et une décision de revue par workflow.
    expect(
      await rows(sql`select workflow_id from quality_control_jobs group by 1 having count(*) > 1`),
    ).toHaveLength(0);
    expect(
      await rows(sql`select "workflowId" from decisions group by 1 having count(*) > 1`),
    ).toHaveLength(0);
  }

  // ─────────────────────────────── 1. crash après claim de dispatch, avant confirmation ───────────────────

  it("1a. crash after Temporal accepted but before markDispatched (autonomous mission) → replayed, one workflow", async () => {
    const first = boot();
    temporal.crashAfterAcceptOnce = true;
    await expect(first.ignite()).rejects.toThrow("SIMULATED_KILL");
    const [attempt] = await first.dispatchAttempts.listPrepared();
    expect(attempt.state).toBe("prepared"); // ICOS never learnt the workflow was accepted

    const second = boot(); // restart
    await second.tick();

    const after = await second.dispatchAttempts.getByWorkflowId(attempt.workflowId);
    expect(after?.state).toBe("dispatched");
    expect(temporal.started.size).toBe(1);
    expect(temporal.callsFor(attempt.workflowId)).toBe(2); // original + replay, deduplicated by Temporal
    expect(await count(sql`select count(*) n from dispatch_attempts`)).toBe(1);
    await expectNoDuplicates();
  });

  it("1b. crash before confirmation on a mission WITHOUT a live runtime → replayed (7C gap: prepared orphan)", async () => {
    const first = boot();
    const mission = await first.missions.create({
      title: "Legacy",
      objective: "no autonomous runtime",
      tasks: [
        {
          title: "Legacy task",
          description: "x",
          dependsOn: [],
          workerKind: "agent",
          capability: null,
        },
      ],
    });
    temporal.crashAfterAcceptOnce = true;
    await expect(first.supervisor.run(mission.id)).rejects.toThrow("SIMULATED_KILL");
    expect(await first.dispatchAttempts.listPrepared(mission.id)).toHaveLength(1);

    const second = boot();
    await second.tick();

    expect(await second.dispatchAttempts.listPrepared(mission.id)).toHaveLength(0);
    expect(temporal.started.size).toBe(1);
    await expectNoDuplicates();
  });

  it("1c. crash BEFORE Temporal saw the dispatch → the workflow is started exactly once by recovery", async () => {
    const first = boot();
    temporal.crashBeforeAcceptOnce = true;
    await expect(first.ignite()).rejects.toThrow("SIMULATED_KILL");
    expect(temporal.started.size).toBe(0);

    await boot().tick();

    expect(temporal.started.size).toBe(1);
    await expectNoDuplicates();
  });

  // ─────────────────────────────── 2. crash après exécution worker, avant callback completed ──────────────

  it("2a. worker still running (no callback yet) → recovery leaves it alone; the late callback completes the mission", async () => {
    const first = boot();
    const missionId = await first.ignite();
    const wf = await workflowOf(first, missionId, "a");

    const second = boot();
    for (let i = 0; i < 3; i += 1) await second.tick();
    expect(temporal.callsFor(wf)).toBe(1); // no re-dispatch of a live workflow
    expect(await count(sql`select count(*) n from task_execution_results`)).toBe(0);

    await second.callback(wf);
    await ageResults();
    for (let i = 0; i < 3; i += 1) await second.tick();

    expect(await missionStatus(second, missionId)).toBe("succeeded");
    await expectNoDuplicates();
  });

  it("2b. workflow closed WITHOUT callback → recorded as a worker failure (never success), QC retries with a NEW attempt", async () => {
    const first = boot();
    const missionId = await first.ignite();
    const wf = await workflowOf(first, missionId, "a");
    temporal.started.set(wf, "closed"); // worker done / callback lost, process died

    const second = boot();
    await second.tick(); // 7C records the lost execution as a failure
    const [result] = await rows<{ outcome: string; error_code: string }>(
      sql`select outcome, error_code from task_execution_results where workflow_id = ${wf}`,
    );
    expect(result).toMatchObject({ outcome: "failure", error_code: "UNKNOWN_EFFECT" });
    expect(await missionStatus(second, missionId)).not.toBe("succeeded");

    await ageResults();
    await second.tick(); // QC (unregistered result) → RETRY → attempt 2 prepared + dispatched
    const retryWf = `${wf}-attempt-2`;
    expect((await second.dispatchAttempts.getByWorkflowId(retryWf))?.state).toBe("dispatched");
    expect(temporal.started.has(retryWf)).toBe(true);
    expect(llm.calls).toBe(0); // deterministic RETRY: a reviewer outage is never involved

    await second.callback(retryWf); // the retried worker succeeds
    await ageResults();
    for (let i = 0; i < 3; i += 1) await second.tick();
    expect(await missionStatus(second, missionId)).toBe("succeeded");
    await expectNoDuplicates();
  });

  it("2c. workflow unknown to Temporal (not_found) → restarted with the SAME workflowId", async () => {
    const first = boot();
    const missionId = await first.ignite();
    const wf = await workflowOf(first, missionId, "a");
    temporal.started.delete(wf); // Temporal lost it

    await boot().tick();

    expect(temporal.started.get(wf)).toBe("running");
    expect(temporal.callsFor(wf)).toBe(2);
    expect(await count(sql`select count(*) n from dispatch_attempts`)).toBe(1);
    await expectNoDuplicates();
  });

  // ─────────────────────────────── 3. crash après execution_result, avant QC ──────────────────────────────

  it("3. crash after execution_result was persisted but before QC registration → QC runs, mission completes", async () => {
    const first = boot();
    const missionId = await first.ignite();
    const wf = await workflowOf(first, missionId, "a");
    await first.callback(wf); // then the process is killed: register() never ran
    await ageResults();
    expect(await count(sql`select count(*) n from quality_control_jobs`)).toBe(0);

    const second = boot();
    await second.tick();

    expect(await missionStatus(second, missionId)).toBe("succeeded");
    expect(await count(sql`select count(*) n from quality_control_jobs`)).toBe(1);
    expect(await count(sql`select count(*) n from decisions`)).toBe(1);
    expect(llm.calls).toBe(1);
    await expectNoDuplicates();
  });

  // ─────────────────────────────── 4. crash après action QC, avant wakeup ─────────────────────────────────

  it("4. crash after the QC action was applied but before the mission was woken → wake-up delivered once", async () => {
    const first = boot(new FixedPlanPlanner([plan("a", "b")]));
    const missionId = await first.ignite();
    const wfA = await workflowOf(first, missionId, "a");
    await first.callback(wfA);
    await first.qc.registerExecution({
      missionId,
      missionTaskId: (await first.dispatchAttempts.getByWorkflowId(wfA))!.missionTaskId,
      taskId: (await first.dispatchAttempts.getByWorkflowId(wfA))!.taskId,
      workflowId: wfA,
    });
    await first.qc.processPending(missionId); // ACCEPT applied, wakeup_pending=true … then kill
    expect((await first.qualityJobs.getByWorkflowId(wfA))?.wakeupPending).toBe(true);
    const wfB = await workflowOf(first, missionId, "b");
    expect(temporal.started.has(wfB)).toBe(false);

    const second = boot(new FixedPlanPlanner([plan("a", "b")]));
    await second.tick();
    expect(temporal.started.has(wfB)).toBe(true);
    expect((await second.qualityJobs.getByWorkflowId(wfA))?.wakeupPending).toBe(false);

    for (let i = 0; i < 3; i += 1) await second.tick(); // idempotent: nothing more happens
    expect(temporal.callsFor(wfB)).toBe(1);
    expect(await count(sql`select count(*) n from decisions`)).toBe(1);
    expect(await count(sql`select count(*) n from dispatch_attempts`)).toBe(2);
    await expectNoDuplicates();
  });

  // ─────────────────────────────── 5. mission waiting, toutes les tâches terminales ───────────────────────

  it("5. runtime `waiting` while every task is already terminal → woken, mission succeeds (7C gap)", async () => {
    const first = boot();
    const missionId = await first.ignite();
    expect((await first.runtime.get(missionId))?.state).toBe("waiting");
    // The callback + QC ACCEPT all happened, but the wake-up was lost (outbox flag already cleared / legacy path).
    await admin.db.execute(
      sql`update mission_tasks set status = 'succeeded' where mission_id = ${missionId}`,
    );
    await admin.db.execute(sql`update tasks set status = 'succeeded' where id in
      (select task_id from mission_tasks where mission_id = ${missionId})`);

    await boot().tick();

    expect(await missionStatus(first, missionId)).toBe("succeeded");
    expect((await first.runtime.get(missionId))?.state).toBe("succeeded");
  });

  it("5b. runtime `waiting` with genuinely active work is NOT woken (no cycle-budget burn)", async () => {
    const first = boot();
    const missionId = await first.ignite();
    const before = (await first.runtime.get(missionId))!;

    await boot().tick();

    expect((await first.runtime.get(missionId))!.cycleCount).toBe(before.cycleCount);
    expect(temporal.callsFor(await workflowOf(first, missionId, "a"))).toBe(1); // live worker: not re-dispatched
  });

  // ─────────────────────────────── 6. lease expirée récupérée ─────────────────────────────────────────────

  it("6a. expired runtime lease (dead owner) is taken over; a LIVE lease is never stolen", async () => {
    const first = boot();
    temporal.crashBeforeAcceptOnce = true;
    await expect(first.ignite()).rejects.toThrow("SIMULATED_KILL");
    const [{ mission_id }] = await rows<{ mission_id: string }>(
      sql`select mission_id from autonomous_mission_runtime`,
    );

    await admin.db.execute(sql`update autonomous_mission_runtime
      set state = 'running', owner_token = 'alive-process', lease_until = now() + interval '10 minutes'`);
    await boot().tick();
    expect(temporal.started.size).toBe(0); // live owner respected
    expect((await first.runtime.get(mission_id))?.ownerToken).toBe("alive-process");

    await killRuntimeOwner(mission_id); // the owner died: its lease is now expired
    await boot().tick();
    expect(temporal.started.size).toBe(1);
    expect((await first.runtime.get(mission_id))?.ownerToken).toBeNull();
    await expectNoDuplicates();
  });

  it("6b. expired QC job claim (reviewer process died mid-review) is recovered; a LIVE claim is left alone", async () => {
    const first = boot();
    const missionId = await first.ignite();
    const wf = await workflowOf(first, missionId, "a");
    const attempt = (await first.dispatchAttempts.getByWorkflowId(wf))!;
    await first.callback(wf);
    await first.qc.registerExecution({
      missionId,
      missionTaskId: attempt.missionTaskId,
      taskId: attempt.taskId,
      workflowId: wf,
    });
    const claimed = await first.qualityJobs.claimNext(missionId, "dead-reviewer", 60_000);
    expect(claimed?.state).toBe("reviewing");

    await boot().tick();
    expect(llm.calls).toBe(0); // live claim: untouched
    expect((await first.qualityJobs.getByWorkflowId(wf))?.state).toBe("reviewing");

    await admin.db.execute(
      sql`update quality_control_jobs set claim_until = now() - interval '1 minute'`,
    );
    await boot().tick();
    expect(await missionStatus(first, missionId)).toBe("succeeded");
    expect(llm.calls).toBe(1);
    await expectNoDuplicates();
  });

  // ─────────────────────────────── 7. sweepers concurrents ────────────────────────────────────────────────

  it("7. two concurrent recovery sweepers never recover the same unit twice", async () => {
    // Unit A: waiting mission with every task terminal.
    const seed = boot(new FixedPlanPlanner([plan("a")]));
    const settledId = await seed.ignite();
    await admin.db.execute(
      sql`update mission_tasks set status = 'succeeded' where mission_id = ${settledId}`,
    );
    // Unit B: prepared dispatch of a runtime-less mission (process killed after Temporal accepted).
    const legacy = await seed.missions.create({
      title: "Legacy",
      objective: "o",
      tasks: [
        { title: "L", description: "x", dependsOn: [], workerKind: "agent", capability: null },
      ],
    });
    temporal.crashAfterAcceptOnce = true;
    await expect(seed.supervisor.run(legacy.id)).rejects.toThrow("SIMULATED_KILL");
    const [prepared] = await seed.dispatchAttempts.listPrepared(legacy.id);
    // Unit C: worker result persisted, QC never registered.
    const third = await seed.ignite();
    const wfC = await workflowOf(seed, third, "a");
    await seed.callback(wfC);
    await ageResults();

    // Two "processes", each running the full production chain AND the 7C sweeper, all at once.
    const [a, b] = [boot(), boot()];
    await Promise.all([a.tick(), b.tick(), a.recovery7c.sweep(), b.recovery7c.sweep()]);

    expect(temporal.callsFor(prepared.workflowId)).toBe(2); // original + exactly ONE replay
    /*
     * The wake-up did its job: a mission whose every task is terminal comes back SETTLED.
     *
     * This used to assert `cycleCount === cyclesBefore + 1`, using "a cycle was burned" as
     * the proxy for "woken once". Settlement is now decided before the runner spends
     * anything, so a finished mission costs zero cycles — the proxy reads 0 while the
     * mission is correctly succeeded. "Once, not twice" is not weakened by dropping it:
     * that is asserted directly below, as exactly one resolved `waiting_settled` unit.
     */
    expect((await seed.missions.findById(settledId))!.status).toBe("succeeded");
    expect(await count(sql`select count(*) n from decisions where "workflowId" = ${wfC}`)).toBe(1);
    expect(llm.calls).toBe(1);
    // Each recovery unit was resolved exactly once (PK (kind, unit_key) + fenced claim).
    const resolved = await rows<{ kind: string; n: string }>(
      sql`select kind, count(*) n from recovery_units where resolved_at is not null group by kind order by kind`,
    );
    if (!DISABLED_7C) {
      expect(resolved.map((r) => [r.kind, Number(r.n)])).toEqual([
        ["dispatch_prepared_stale", 1],
        ["waiting_settled", 1],
      ]);
    }
    await expectNoDuplicates();
  });

  // ─────────────────────────────── 8. redémarrage complet avec reprise ────────────────────────────────────

  it("8. full restart cycles: kill → restart → ICOS continues a 3-task DAG to success, untouched by humans", async () => {
    const planner = () => new FixedPlanPlanner([plan("a", "b", "c")]);
    let stack = boot(planner());
    const missionId = await stack.ignite();

    for (const key of ["a", "b", "c"]) {
      const wf = await workflowOf(stack, missionId, key);
      expect(temporal.started.has(wf)).toBe(true); // dispatched by the previous incarnation / recovery
      // KILL: the process dies; the worker finishes while ICOS is down and its callback lands on the restarted process.
      await handlesClose();
      stack = boot(planner());
      await stack.callback(wf);
      await ageResults();
      for (let i = 0; i < 3; i += 1) await stack.tick(); // timer ticks after restart
    }

    expect(await missionStatus(stack, missionId)).toBe("succeeded");
    expect((await stack.runtime.get(missionId))?.state).toBe("succeeded");
    expect(temporal.started.size).toBe(3);
    expect(
      await count(sql`select count(*) n from quality_control_jobs where state = 'action_applied'`),
    ).toBe(3);
    expect(await count(sql`select count(*) n from quality_control_jobs where wakeup_pending`)).toBe(
      0,
    );
    await expectNoDuplicates();
  });

  async function handlesClose() {
    while (handles.length) await handles.pop()!.close();
  }
});
