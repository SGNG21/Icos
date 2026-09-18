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

const DATABASE_URL =
  TEST_DATABASE_URL;

// buildPostgresContainer eagerly constructs PostgresReviewerService.
// This N2.4 test injects InMemoryReviewerService for actual review,
// so these values only satisfy constructor-time configuration.
process.env.OMNIROUTE_BASE_URL ??= "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??= "n2-4-test-key";
process.env.ICOS_REVIEWER_MODEL ??= "n2-4-test-model";
process.env.ICOS_REVIEWER_TIMEOUT_MS ??= "1000";

const opened = new Set<Container>();

async function freshProcess(): Promise<Container> {
  const container =
    await buildPostgresContainer(DATABASE_URL);

  opened.add(container);
  return container;
}

async function shutdown(
  container: Container,
): Promise<void> {
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
      workflowId:
        input.workflowId ??
        `icos-task-${input.taskId}`,
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

      // Deterministic APPROVE:
      // review decision is still persisted by the real
      // PostgreSQL ReviewDecisionRepository.
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

describe(
  "N2.4 PostgreSQL mission A -> B -> C across fresh processes",
  () => {
    afterEach(async () => {
      for (const container of [...opened]) {
        await shutdown(container);
      }
    });

    it(
      "reprend la mission sur de nouveaux containers et termine avec 3 attempts completed",
      async () => {
        /*
         * ============================================================
         * CLEAN DISPOSABLE DATABASE
         * ============================================================
         */
        const admin = await freshProcess();

        if (!admin.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        // Disposable DB only.
        // CASCADE clears mission/task dependants:
        // MissionTasks, dispatch ledger, execution results,
        // review decisions, checkpoints, audit references, etc.
        await admin.db.execute(
          sql.raw(
            "TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE",
          ),
        );

        await shutdown(admin);

        /*
         * ============================================================
         * PROCESS A
         * create mission + dispatch A
         * then process dies
         * ============================================================
         */
        const processA = await freshProcess();
        const dispatchA = mockTransport(processA);

        const mission = await processA.mission.create({
          title: "N2.4 Restart Mission",
          objective:
            "A -> B -> C must survive process replacement",
          tasks: [
            {
              title: "Task A",
              description: "STEP_A_OK",
              dependsOn: [],
              workerKind: "agent",
            },
            {
              title: "Task B",
              description: "STEP_B_OK",
              dependsOn: [],
              workerKind: "agent",
            },
            {
              title: "Task C",
              description: "STEP_C_OK",
              dependsOn: [],
              workerKind: "agent",
            },
          ],
        });

        let missionTasks =
          await processA.mission.listTasks(
            mission.id,
          );

        expect(missionTasks).toHaveLength(3);

        const a = missionTasks.find(
          (task) => task.title === "Task A",
        );
        const b = missionTasks.find(
          (task) => task.title === "Task B",
        );
        const c = missionTasks.find(
          (task) => task.title === "Task C",
        );

        if (!a || !b || !c) {
          throw new Error(
            "A/B/C MissionTasks not created",
          );
        }

        // IMPORTANT:
        // dependsOn references MissionTask.id,
        // callbacks/workflows use canonical Task.id.
        await processA.mission.updateMissionTaskDependsOn(
          b.id,
          [a.id],
        );
        await processA.mission.updateMissionTaskDependsOn(
          c.id,
          [b.id],
        );

        missionTasks =
          await processA.mission.listTasks(
            mission.id,
          );

        const refreshedA = missionTasks.find(
          (task) => task.id === a.id,
        )!;
        const refreshedB = missionTasks.find(
          (task) => task.id === b.id,
        )!;
        const refreshedC = missionTasks.find(
          (task) => task.id === c.id,
        )!;

        expect(refreshedA.taskId).not.toBe(
          refreshedA.id,
        );
        expect(refreshedB.dependsOn).toEqual([
          refreshedA.id,
        ]);
        expect(refreshedC.dependsOn).toEqual([
          refreshedB.id,
        ]);

        const workflowA =
          `icos-task-${refreshedA.taskId}`;
        const workflowB =
          `icos-task-${refreshedB.taskId}`;
        const workflowC =
          `icos-task-${refreshedC.taskId}`;

        const supervisorA =
          supervisorFor(processA);

        await supervisorA.run(mission.id);

        expect(dispatchA).toHaveBeenCalledTimes(1);

        expect(
          dispatchA.mock.calls[0]?.[0].taskId,
        ).toBe(refreshedA.taskId);

        expect(
          dispatchA.mock.calls[0]?.[0].workflowId,
        ).toBe(workflowA);

        expect(
          (
            await processA.dispatchAttempts.getByWorkflowId(
              workflowA,
            )
          )?.state,
        ).toBe("dispatched");

        // PROCESS A dies.
        await shutdown(processA);

        /*
         * ============================================================
         * PROCESS B
         * fresh repositories + callback A
         * callback must complete A and dispatch B
         * ============================================================
         */
        const processB = await freshProcess();
        const dispatchB = mockTransport(processB);
        const supervisorB =
          supervisorFor(processB);

        await completeAndReview(
          processB,
          supervisorB,
          {
            missionId: mission.id,
            taskId: refreshedA.taskId,
            workflowId: workflowA,
            result: "A completed",
          },
        );

        expect(
          (
            await processB.dispatchAttempts.getByWorkflowId(
              workflowA,
            )
          )?.state,
        ).toBe("completed");

        expect(dispatchB).toHaveBeenCalledTimes(1);

        expect(
          dispatchB.mock.calls[0]?.[0].taskId,
        ).toBe(refreshedB.taskId);

        expect(
          dispatchB.mock.calls[0]?.[0].workflowId,
        ).toBe(workflowB);

        expect(
          (
            await processB.dispatchAttempts.getByWorkflowId(
              workflowB,
            )
          )?.state,
        ).toBe("dispatched");

        // PROCESS B dies.
        await shutdown(processB);

        /*
         * ============================================================
         * PROCESS C
         * fresh repositories + callback B
         * callback must complete B and dispatch C
         * ============================================================
         */
        const processC = await freshProcess();
        const dispatchC = mockTransport(processC);
        const supervisorC =
          supervisorFor(processC);

        await completeAndReview(
          processC,
          supervisorC,
          {
            missionId: mission.id,
            taskId: refreshedB.taskId,
            workflowId: workflowB,
            result: "B completed",
          },
        );

        expect(
          (
            await processC.dispatchAttempts.getByWorkflowId(
              workflowB,
            )
          )?.state,
        ).toBe("completed");

        expect(dispatchC).toHaveBeenCalledTimes(1);

        expect(
          dispatchC.mock.calls[0]?.[0].taskId,
        ).toBe(refreshedC.taskId);

        expect(
          dispatchC.mock.calls[0]?.[0].workflowId,
        ).toBe(workflowC);

        expect(
          (
            await processC.dispatchAttempts.getByWorkflowId(
              workflowC,
            )
          )?.state,
        ).toBe("dispatched");

        // PROCESS C dies.
        await shutdown(processC);

        /*
         * ============================================================
         * PROCESS D
         * fresh repositories + callback C
         * mission must terminate
         * ============================================================
         */
        const processD = await freshProcess();
        const dispatchD = mockTransport(processD);
        const supervisorD =
          supervisorFor(processD);

        await completeAndReview(
          processD,
          supervisorD,
          {
            missionId: mission.id,
            taskId: refreshedC.taskId,
            workflowId: workflowC,
            result: "C completed",
          },
        );

        // Nothing remains to dispatch.
        expect(dispatchD).toHaveBeenCalledTimes(0);

        /*
         * ============================================================
         * FINAL DURABLE ASSERTIONS
         * ============================================================
         */
        const finalMission =
          await processD.mission.findById(
            mission.id,
          );

        expect(finalMission?.status).toBe(
          "succeeded",
        );

        const finalTasks =
          await processD.mission.listTasks(
            mission.id,
          );

        expect(
          finalTasks
            .map((task) => ({
              title: task.title,
              status: task.status,
            }))
            .sort((a, b) => a.title.localeCompare(b.title)),
        ).toEqual([
          {
            title: "Task A",
            status: "succeeded",
          },
          {
            title: "Task B",
            status: "succeeded",
          },
          {
            title: "Task C",
            status: "succeeded",
          },
        ]);

        if (!processD.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        const attempts = await processD.db
          .select()
          .from(dispatchAttempts);

        expect(attempts).toHaveLength(3);

        expect(
          attempts.every(
            (attempt) =>
              attempt.state === "completed",
          ),
        ).toBe(true);

        expect(
          new Set(
            attempts.map(
              (attempt) => attempt.workflowId,
            ),
          ).size,
        ).toBe(3);

        expect(
          attempts
            .map((attempt) => attempt.workflowId)
            .sort(),
        ).toEqual(
          [
            workflowA,
            workflowB,
            workflowC,
          ].sort(),
        );

        expect(
          await processD.dispatchAttempts.listPrepared(
            mission.id,
          ),
        ).toHaveLength(0);

        expect(
          (
            await processD.dispatchAttempts.getByWorkflowId(
              workflowC,
            )
          )?.state,
        ).toBe("completed");

        await shutdown(processD);
      },
    );
  },
);
