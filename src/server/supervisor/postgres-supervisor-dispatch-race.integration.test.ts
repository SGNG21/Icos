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
import { SupervisorService } from "@/server/supervisor/supervisor-service";

const DATABASE_URL =
  TEST_DATABASE_URL;

process.env.OMNIROUTE_BASE_URL ??= "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??= "n2-6-race-test-key";
process.env.ICOS_REVIEWER_MODEL ??= "n2-6-race-test-model";
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
      workflowId:
        input.workflowId ?? `icos-task-${input.taskId}`,
    }));
}

function createBarrier(target: number) {
  let reached = 0;
  let release!: () => void;

  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    reached += 1;

    if (reached === target) {
      release();
    }

    await released;
  };
}

/**
 * Force the first listTasks() made by each Supervisor to rendezvous.
 *
 * This guarantees that all Supervisors have observed the same initial
 * MissionTask state before any of them can call prepare().
 */
function synchronizeInitialRead(
  container: Container,
  barrier: () => Promise<void>,
) {
  const original =
    container.mission.listTasks.bind(container.mission);

  let firstCall = true;

  vi.spyOn(container.mission, "listTasks")
    .mockImplementation(async (missionId) => {
      const result = await original(missionId);

      if (firstCall) {
        firstCall = false;
        await barrier();
      }

      return result;
    });
}

describe(
  "N2.6 dispatch ownership race between concurrent Supervisors",
  () => {
    afterEach(async () => {
      for (const container of [...opened]) {
        await shutdown(container);
      }
    });

    it(
      "allows only one external dispatch per logical task when 3 Supervisors observe the same ready set",
      async () => {
        /*
         * ------------------------------------------------------------
         * CLEAN DISPOSABLE DB
         * ------------------------------------------------------------
         */
        const admin = await freshProcess();

        if (!admin.db) {
          throw new Error("db handle unavailable");
        }

        await admin.db.execute(
          sql.raw(
            "TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE",
          ),
        );

        await shutdown(admin);

        /*
         * ------------------------------------------------------------
         * SEED
         * ------------------------------------------------------------
         */
        const seed = await freshProcess();

        const mission = await seed.mission.create({
          title: "N2.6 Supervisor Dispatch Race",
          objective:
            "Prove atomic ownership of external dispatch",
          tasks: Array.from({ length: 10 }, (_, i) => ({
            title: `Race Task ${i}`,
            description: `RACE_${i}_OK`,
            dependsOn: [],
            workerKind: `kind${i % 4}`,
            capability: `cap${i % 4}`,
          })),
        });

        const seededTasks =
          await seed.mission.listTasks(mission.id);

        expect(seededTasks).toHaveLength(10);
        expect(
          seededTasks.every((task) => task.status === "draft"),
        ).toBe(true);

        await shutdown(seed);

        /*
         * ------------------------------------------------------------
         * THREE INDEPENDENT PROCESSES
         * ------------------------------------------------------------
         */
        const processA = await freshProcess();
        const processB = await freshProcess();
        const processC = await freshProcess();

        const dispatchA = mockTransport(processA);
        const dispatchB = mockTransport(processB);
        const dispatchC = mockTransport(processC);

        const supervisorA = supervisorFor(processA);
        const supervisorB = supervisorFor(processB);
        const supervisorC = supervisorFor(processC);

        /*
         * All three initial listTasks() calls must complete before
         * any Supervisor is allowed to continue into prepare().
         */
        const barrier = createBarrier(3);

        synchronizeInitialRead(processA, barrier);
        synchronizeInitialRead(processB, barrier);
        synchronizeInitialRead(processC, barrier);

        /*
         * ------------------------------------------------------------
         * REAL CONCURRENT RUN
         * ------------------------------------------------------------
         */
        const results = await Promise.allSettled([
          supervisorA.run(mission.id),
          supervisorB.run(mission.id),
          supervisorC.run(mission.id),
        ]);

        const rejected = results.filter(
          (result) => result.status === "rejected",
        );

        expect(rejected).toEqual([]);

        /*
         * ------------------------------------------------------------
         * LEDGER INVARIANTS
         * ------------------------------------------------------------
         */
        if (!processA.db) {
          throw new Error("db handle unavailable");
        }

        const attempts = await processA.db
          .select()
          .from(dispatchAttempts);

        expect(attempts).toHaveLength(10);

        const workflowIds = attempts.map(
          (attempt) => attempt.workflowId,
        );

        expect(new Set(workflowIds).size).toBe(10);

        expect(
          new Set(
            attempts.map(
              (attempt) =>
                `${attempt.missionTaskId}:${attempt.attempt}`,
            ),
          ).size,
        ).toBe(10);

        /*
         * ------------------------------------------------------------
         * EXTERNAL SIDE-EFFECT INVARIANT
         * ------------------------------------------------------------
         *
         * The ledger having only 10 rows is NOT sufficient.
         *
         * There must also be exactly 10 external dispatch calls in
         * total, otherwise multiple Supervisors performed the same
         * side effect for the same durable intent.
         */
        const externalDispatchCount =
          dispatchA.mock.calls.length +
          dispatchB.mock.calls.length +
          dispatchC.mock.calls.length;

        console.log(
          "N2.6 race result:",
          JSON.stringify(
            {
              ledgerRows: attempts.length,
              uniqueWorkflowIds:
                new Set(workflowIds).size,
              dispatchA: dispatchA.mock.calls.length,
              dispatchB: dispatchB.mock.calls.length,
              dispatchC: dispatchC.mock.calls.length,
              externalDispatchCount,
            },
            null,
            2,
          ),
        );

        expect(externalDispatchCount).toBe(10);

        /*
         * Every logical workflow may have been externally dispatched
         * exactly once.
         */
        const externallyDispatchedWorkflowIds = [
          ...dispatchA.mock.calls,
          ...dispatchB.mock.calls,
          ...dispatchC.mock.calls,
        ].map(
          ([input]) =>
            input.workflowId ??
            `icos-task-${input.taskId}`,
        );

        expect(
          new Set(externallyDispatchedWorkflowIds).size,
        ).toBe(10);

        expect(
          externallyDispatchedWorkflowIds,
        ).toHaveLength(10);
      },
    );
  },
);
