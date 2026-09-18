import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";

import {
  buildPostgresContainer,
  type Container,
} from "@/server/container";
import { dispatchAttempts } from "@/server/database/schema";
import { InMemoryReviewerService } from "@/server/review/in-memory-reviewer-service";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import type { MissionTask } from "@/core/mission/contracts";

const DATABASE_URL =
  TEST_DATABASE_URL;

// buildPostgresContainer construit PostgresReviewerService au moment de
// l'instanciation : ces valeurs ne font que satisfaire sa configuration.
process.env.OMNIROUTE_BASE_URL ??= "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??= "n2-5-test-key";
process.env.ICOS_REVIEWER_MODEL ??= "n2-5-test-model";
process.env.ICOS_REVIEWER_TIMEOUT_MS ??= "1000";

const opened = new Set<Container>();

async function freshProcess(): Promise<Container> {
  const container = await buildPostgresContainer(DATABASE_URL);
  opened.add(container);
  return container;
}

async function shutdown(container: Container): Promise<void> {
  if (!opened.has(container)) return;
  opened.delete(container);
  await container.close();
}

function supervisorFor(container: Container) {
  return new SupervisorService(
    container.mission,
    container.tasks,
    container.taskExecution,
    container.durableMemory,
    container.dispatchAttempts,
  );
}

function mockTransport(container: Container) {
  return vi
    .spyOn(container.taskExecution, "dispatch")
    .mockImplementation(async (input) => ({
      workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
    }));
}

async function completeAndReview(
  container: Container,
  supervisor: SupervisorService,
  input: {
    missionId: string;
    taskId: string;
    workflowId: string;
    result: string;
  },
): Promise<void> {
  const completedAt = new Date().toISOString();

  const execution = await recordTaskExecution(
    {
      tasks: container.tasks,
      executionResults: container.executionResults,
      supervisor,
      missions: container.mission,
      durableMemory: container.durableMemory,
    },
    {
      taskId: input.taskId,
      workflowId: input.workflowId,
      outcome: "success",
      result: input.result,
      completedAt,
    },
  );

  expect(execution.ok).toBe(true);

  await recordMissionTaskExecution(
    {
      executionResults: container.executionResults,
      supervisor,
      missions: container.mission,
      tasks: container.tasks,
      reviewer: new InMemoryReviewerService(),
      reviewDecisions: container.reviewDecisions,
      taskExecution: container.taskExecution,
      durableMemory: container.durableMemory,
      dispatchAttempts: container.dispatchAttempts,
    },
    {
      missionId: input.missionId,
      taskId: input.taskId,
      workflowId: input.workflowId,
      outcome: "success",
      result: input.result,
      completedAt,
    },
  );
}

describe("N2.5 PostgreSQL multi-branch DAG across restarts", () => {
  afterEach(async () => {
    for (const container of [...opened]) {
      await shutdown(container);
    }
  });

  it(
    "A -> (B,C,D) ; B+C -> E ; D -> F ; E+F -> G sur des processus recomposés",
    async () => {
      /*
       * ============================================================
       * CLEAN DISPOSABLE DATABASE
       * ============================================================
       */
      const admin = await freshProcess();
      if (!admin.db) throw new Error("db handle unavailable");
      await admin.db.execute(
        sql.raw(
          "TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE",
        ),
      );
      await shutdown(admin);

      // Registre cumulé des dispatches observés sur tous les processus.
      const dispatchedTaskIds: Array<{ taskId: string; workflowId: string }> = [];
      let dispatchCalls = 0;

      // Each mock keeps its full call history. Only record calls that have not
      // already been accounted for, otherwise repeated recordDispatches()
      // calls would count old dispatches again.
      const recordedCallCount = new WeakMap<object, number>();

      const recordDispatches = (mock: ReturnType<typeof mockTransport>) => {
        const alreadyRecorded = recordedCallCount.get(mock) ?? 0;
        const newCalls = mock.mock.calls.slice(alreadyRecorded);

        for (const call of newCalls) {
          dispatchedTaskIds.push({
            taskId: call[0].taskId,
            workflowId: call[0].workflowId ?? `icos-task-${call[0].taskId}`,
          });
          dispatchCalls += 1;
        }

        recordedCallCount.set(mock, mock.mock.calls.length);
      };

      /*
       * ============================================================
       * PROCESS 1 : create mission + wire DAG + dispatch A
       * ============================================================
       */
      const processA = await freshProcess();
      const dispatchA = mockTransport(processA);
      const supervisorA = supervisorFor(processA);

      const mission = await processA.mission.create({
        title: "N2.5 Multi-branch DAG",
        objective: "B+C -> E, D -> F, E+F -> G must hold across restarts",
        tasks: [
          { title: "Task A", description: "STEP_A_OK", dependsOn: [], workerKind: "agent" },
          { title: "Task B", description: "STEP_B_OK", dependsOn: [], workerKind: "agent" },
          { title: "Task C", description: "STEP_C_OK", dependsOn: [], workerKind: "agent" },
          { title: "Task D", description: "STEP_D_OK", dependsOn: [], workerKind: "agent" },
          { title: "Task E", description: "STEP_E_OK", dependsOn: [], workerKind: "agent" },
          { title: "Task F", description: "STEP_F_OK", dependsOn: [], workerKind: "agent" },
          { title: "Task G", description: "STEP_G_OK", dependsOn: [], workerKind: "agent" },
        ],
      });

      let tasks = await processA.mission.listTasks(mission.id);
      expect(tasks).toHaveLength(7);

      const byTitle = new Map<string, MissionTask>(
        tasks.map((t) => [t.title, t]),
      );
      const a = byTitle.get("Task A")!;
      const b = byTitle.get("Task B")!;
      const c = byTitle.get("Task C")!;
      const d = byTitle.get("Task D")!;
      const e = byTitle.get("Task E")!;
      const f = byTitle.get("Task F")!;
      const g = byTitle.get("Task G")!;

      // Identité DAG (MissionTask.id) != tâche canonique (taskId).
      const allTitles = [a, b, c, d, e, f, g];
      for (const t of allTitles) {
        expect(t.id).not.toBe(t.taskId);
      }

      // A ; B,C,D <- A ; E <- B,C ; F <- D ; G <- E,F
      await processA.mission.updateMissionTaskDependsOn(b.id, [a.id]);
      await processA.mission.updateMissionTaskDependsOn(c.id, [a.id]);
      await processA.mission.updateMissionTaskDependsOn(d.id, [a.id]);
      await processA.mission.updateMissionTaskDependsOn(e.id, [b.id, c.id]);
      await processA.mission.updateMissionTaskDependsOn(f.id, [d.id]);
      await processA.mission.updateMissionTaskDependsOn(g.id, [e.id, f.id]);

      tasks = await processA.mission.listTasks(mission.id);
      const refreshed = new Map<string, MissionTask>(
        tasks.map((t) => [t.title, t]),
      );
      const refreshedE = refreshed.get("Task E")!;
      const refreshedF = refreshed.get("Task F")!;
      const refreshedG = refreshed.get("Task G")!;

      const workflow = (t: { taskId: string }) =>
        `icos-task-${t.taskId}`;

      // run() : seule A est ready -> 1 dispatch.
      await supervisorA.run(mission.id);
      expect(dispatchA).toHaveBeenCalledTimes(1);
      expect(dispatchA.mock.calls[0]?.[0].taskId).toBe(a.taskId);
      recordDispatches(dispatchA);

      // Callback A -> B, C, D touts ready en même temps -> 3 dispatches.
      await completeAndReview(processA, supervisorA, {
        missionId: mission.id,
        taskId: a.taskId,
        workflowId: workflow(a),
        result: "A done",
      });
      recordDispatches(dispatchA);
      expect(dispatchCalls).toBe(4);
      expect(dispatchedTaskIds.map((x) => x.taskId).sort()).toEqual(
        [a, b, c, d].map((x) => x.taskId).sort(),
      );

      // Appels redondants de run() : rien de nouveau à dispatcher
      // (les tâches sont queued) -> aucun double dispatch logique.
      await supervisorA.run(mission.id);
      await supervisorA.run(mission.id);
      expect(dispatchCalls).toBe(4);

      // Vérification durable : B, C, D sont "dispatched" dans le ledger.
      for (const t of [b, c, d]) {
        expect(
          (await processA.dispatchAttempts.getByWorkflowId(workflow(t)))?.state,
        ).toBe("dispatched");
      }

      // E ne doit pas exister tant que B ET C n'ont pas réussi.
      expect(
        await processA.dispatchAttempts.getByWorkflowId(workflow(e)),
      ).toBeNull();
      // F ne doit pas exister tant que D n'a pas réussi.
      expect(
        await processA.dispatchAttempts.getByWorkflowId(workflow(f)),
      ).toBeNull();

      // PROCESS 1 meurt.
      await shutdown(processA);

      /*
       * ============================================================
       * PROCESS 2 : callbacks hors ordre (C puis B) -> E
       * ============================================================
       */
      const processB = await freshProcess();
      const dispatchB = mockTransport(processB);
      const supervisorB = supervisorFor(processB);

      // Hors ordre : C arrive AVANT B. E ne doit PAS se dispatcher (B pas réussi).
      await completeAndReview(processB, supervisorB, {
        missionId: mission.id,
        taskId: c.taskId,
        workflowId: workflow(c),
        result: "C done",
      });
      recordDispatches(dispatchB);
      expect(dispatchB).toHaveBeenCalledTimes(0);
      expect(dispatchCalls).toBe(4);
      expect(
        await processB.dispatchAttempts.getByWorkflowId(workflow(e)),
      ).toBeNull();

      // B arrive : B+C réussis -> E dispatché.
      await completeAndReview(processB, supervisorB, {
        missionId: mission.id,
        taskId: b.taskId,
        workflowId: workflow(b),
        result: "B done",
      });
      recordDispatches(dispatchB);
      expect(dispatchB).toHaveBeenCalledTimes(1);
      expect(dispatchCalls).toBe(5);
      expect(dispatchB.mock.calls[0]?.[0].taskId).toBe(e.taskId);
      expect(
        (await processB.dispatchAttempts.getByWorkflowId(workflow(e)))?.state,
      ).toBe("dispatched");

      // F reste interdit tant que D n'a pas réussi.
      expect(
        await processB.dispatchAttempts.getByWorkflowId(workflow(f)),
      ).toBeNull();
      // G reste interdit tant que E+F pas réussis.
      expect(
        await processB.dispatchAttempts.getByWorkflowId(workflow(g)),
      ).toBeNull();

      // PROCESS 2 meurt.
      await shutdown(processB);

      /*
       * ============================================================
       * PROCESS 3 : hors ordre (E puis D) -> F, puis F -> G
       * ============================================================
       */
      const processC = await freshProcess();
      const dispatchC3 = mockTransport(processC);
      const supervisorC3 = supervisorFor(processC);

      // E arrive avant D : F reste bloqué (D en attente) -> aucun dispatch.
      await completeAndReview(processC, supervisorC3, {
        missionId: mission.id,
        taskId: e.taskId,
        workflowId: workflow(e),
        result: "E done",
      });
      recordDispatches(dispatchC3);
      expect(dispatchC3).toHaveBeenCalledTimes(0);

      // D arrive : F devient ready -> dispatch F.
      await completeAndReview(processC, supervisorC3, {
        missionId: mission.id,
        taskId: d.taskId,
        workflowId: workflow(d),
        result: "D done",
      });
      recordDispatches(dispatchC3);
      expect(dispatchC3).toHaveBeenCalledTimes(1);
      expect(dispatchC3.mock.calls[0]?.[0].taskId).toBe(f.taskId);

      // G toujours interdit (F pas réussi) malgré E réussi.
      expect(
        await processC.dispatchAttempts.getByWorkflowId(workflow(g)),
      ).toBeNull();

      // F arrive : E+F réussis -> G dispatché.
      await completeAndReview(processC, supervisorC3, {
        missionId: mission.id,
        taskId: f.taskId,
        workflowId: workflow(f),
        result: "F done",
      });
      recordDispatches(dispatchC3);
      expect(dispatchC3).toHaveBeenCalledTimes(2);
      expect(dispatchC3.mock.calls[1]?.[0].taskId).toBe(g.taskId);
      expect(
        (await processC.dispatchAttempts.getByWorkflowId(workflow(g)))?.state,
      ).toBe("dispatched");

      // PROCESS 3 meurt.
      await shutdown(processC);

      /*
       * ============================================================
       * PROCESS 4 : callback G -> mission succeeded
       * ============================================================
       */
      const processD = await freshProcess();
      const dispatchD = mockTransport(processD);
      const supervisorD = supervisorFor(processD);

      // run() redondant depuis un processus neuf : rien à redéclencher.
      await supervisorD.run(mission.id);
      await supervisorD.recover(mission.id);

      await completeAndReview(processD, supervisorD, {
        missionId: mission.id,
        taskId: g.taskId,
        workflowId: workflow(g),
        result: "G done",
      });
      recordDispatches(dispatchD);

      // Rien ne reste à dispatcher.
      expect(dispatchD).toHaveBeenCalledTimes(0);
      expect(dispatchCalls).toBe(7);

      /*
       * ============================================================
       * ASSERTIONS DURABLES FINALES
       * ============================================================
       */
      const finalMission = await processD.mission.findById(mission.id);
      expect(finalMission?.status).toBe("succeeded");

      const finalTasks = await processD.mission.listTasks(mission.id);
      expect(finalTasks.every((t) => t.status === "succeeded")).toBe(true);

      // Aucun double dispatch logique : exactement 7 tentatives, une par tâche,
      // workflowIds uniques, toutes "completed".
      if (!processD.db) throw new Error("db handle unavailable");
      const attempts = await processD.db.select().from(dispatchAttempts);
      expect(attempts).toHaveLength(7);
      expect(
        new Set(attempts.map((x) => x.workflowId)).size,
      ).toBe(7);
      expect(attempts.every((x) => x.state === "completed")).toBe(true);

      // Aucune dépendance violée : l'ordre de dispatch réel respecte le DAG.
      const order = [
        a.taskId,
        b.taskId,
        c.taskId,
        d.taskId,
        e.taskId,
        f.taskId,
        g.taskId,
      ];
      const dispatchOrder = dispatchedTaskIds.map((x) => x.taskId);
      // A d'abord ; E seulement après B et C ; F seulement après D ; G en dernier.
      expect(dispatchOrder[0]).toBe(a.taskId);
      expect(dispatchOrder.indexOf(e.taskId)).toBeGreaterThan(
        Math.max(
          dispatchOrder.indexOf(b.taskId),
          dispatchOrder.indexOf(c.taskId),
        ),
      );
      expect(dispatchOrder.indexOf(f.taskId)).toBeGreaterThan(
        dispatchOrder.indexOf(d.taskId),
      );
      expect(dispatchOrder.indexOf(g.taskId)).toBeGreaterThan(
        Math.max(
          dispatchOrder.indexOf(e.taskId),
          dispatchOrder.indexOf(f.taskId),
        ),
      );

      await shutdown(processD);
    },
  );
});