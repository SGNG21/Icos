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

import {
  dispatchAttempts,
} from "@/server/database/schema";

import { SupervisorService } from "@/server/supervisor/supervisor-service";

const DATABASE_URL =
  TEST_DATABASE_URL;

process.env.OMNIROUTE_BASE_URL ??=
  "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??=
  "n2-6-recovery-race-key";
process.env.ICOS_REVIEWER_MODEL ??=
  "n2-6-recovery-race-model";
process.env.ICOS_REVIEWER_TIMEOUT_MS ??=
  "1000";

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

function supervisorFor(
  container: Container,
): SupervisorService {
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
 * Force every recovery process to read the same PREPARED row
 * before any process is allowed to continue.
 *
 * Without this rendezvous one process might mark the attempt
 * dispatched before another process calls listPrepared(),
 * hiding the actual race.
 */
function synchronizePreparedRead(
  container: Container,
  barrier: () => Promise<void>,
) {
  const original =
    container.dispatchAttempts.listPrepared.bind(
      container.dispatchAttempts,
    );

  let firstCall = true;

  vi.spyOn(
    container.dispatchAttempts,
    "listPrepared",
  ).mockImplementation(async (missionId) => {
    const rows = await original(missionId);

    if (firstCall) {
      firstCall = false;
      await barrier();
    }

    return rows;
  });
}

describe(
  "N2.6-R concurrent recovery ownership",
  () => {
    afterEach(async () => {
      for (const container of [...opened]) {
        await shutdown(container);
      }
    });

    it(
      "allows exactly one external redispatch when 3 recoverers observe the same PREPARED attempt",
      async () => {
        /*
         * ----------------------------------------------------------
         * CLEAN DISPOSABLE DATABASE
         * ----------------------------------------------------------
         */
        const admin = await freshProcess();

        if (!admin.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        await admin.db.execute(
          sql.raw(
            "TRUNCATE TABLE missions, tasks " +
              "RESTART IDENTITY CASCADE",
          ),
        );

        await shutdown(admin);

        /*
         * ----------------------------------------------------------
         * PROCESS SEED
         *
         * Create one mission/task and persist exactly one PREPARED
         * dispatch intent. No external dispatch occurs.
         * ----------------------------------------------------------
         */
        const seed = await freshProcess();

        const mission =
          await seed.mission.create({
            title:
              "N2.6-R Concurrent Recovery",
            objective:
              "Only one recoverer may repeat external dispatch",
            tasks: [
              {
                title:
                  "Recovery Race Task",
                description:
                  "RECOVERY_RACE_OK",
                dependsOn: [],
                workerKind: "agent",
                capability:
                  "test.recovery-race",
              },
            ],
          });

        const missionTasks =
          await seed.mission.listTasks(
            mission.id,
          );

        expect(missionTasks).toHaveLength(1);

        const missionTask = missionTasks[0];

        const prepared =
          await seed.dispatchAttempts.prepare({
            missionId: mission.id,
            missionTaskId: missionTask.id,
            taskId: missionTask.taskId,
            attempt: 1,
            workflowId:
              `icos-task-${missionTask.taskId}`,
            prompt:
              missionTask.description ??
              missionTask.title,
            workerKind:
              missionTask.workerKind ?? undefined,
            capability:
              missionTask.capability ?? undefined,
          });

        expect(prepared.acquired).toBe(true);
        expect(prepared.attempt.state).toBe(
          "prepared",
        );

        // Simulate crash before external dispatch / markDispatched.
        await shutdown(seed);

        /*
         * ----------------------------------------------------------
         * THREE INDEPENDENT RECOVERY PROCESSES
         * ----------------------------------------------------------
         */
        const processA = await freshProcess();
        const processB = await freshProcess();
        const processC = await freshProcess();

        const dispatchA =
          mockTransport(processA);
        const dispatchB =
          mockTransport(processB);
        const dispatchC =
          mockTransport(processC);

        const supervisorA =
          supervisorFor(processA);
        const supervisorB =
          supervisorFor(processB);
        const supervisorC =
          supervisorFor(processC);

        /*
         * All three must have observed PREPARED before anyone
         * is allowed to continue.
         */
        const barrier = createBarrier(3);

        synchronizePreparedRead(
          processA,
          barrier,
        );
        synchronizePreparedRead(
          processB,
          barrier,
        );
        synchronizePreparedRead(
          processC,
          barrier,
        );

        /*
         * ----------------------------------------------------------
         * REAL CONCURRENT RECOVERY
         * ----------------------------------------------------------
         */
        const results =
          await Promise.allSettled([
            supervisorA
              .reconcilePreparedDispatches(
                mission.id,
              ),
            supervisorB
              .reconcilePreparedDispatches(
                mission.id,
              ),
            supervisorC
              .reconcilePreparedDispatches(
                mission.id,
              ),
          ]);

        const rejected = results.filter(
          (result) =>
            result.status === "rejected",
        );

        expect(rejected).toEqual([]);

        /*
         * ----------------------------------------------------------
         * DURABLE LEDGER
         * ----------------------------------------------------------
         */
        if (!processA.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        const rows = await processA.db
          .select()
          .from(dispatchAttempts);

        expect(rows).toHaveLength(1);

        expect(rows[0]?.workflowId).toBe(
          `icos-task-${missionTask.taskId}`,
        );

        expect(rows[0]?.state).toBe(
          "dispatched",
        );

        /*
         * ----------------------------------------------------------
         * EXTERNAL SIDE-EFFECT INVARIANT
         * ----------------------------------------------------------
         *
         * THIS is the important assertion.
         *
         * One durable row is insufficient proof: there must also
         * have been exactly ONE external dispatcher call.
         */
        const externalDispatchCount =
          dispatchA.mock.calls.length +
          dispatchB.mock.calls.length +
          dispatchC.mock.calls.length;

        console.log(
          "N2.6-R recovery race result:",
          JSON.stringify(
            {
              ledgerRows: rows.length,
              dispatchA:
                dispatchA.mock.calls.length,
              dispatchB:
                dispatchB.mock.calls.length,
              dispatchC:
                dispatchC.mock.calls.length,
              externalDispatchCount,
            },
            null,
            2,
          ),
        );

        expect(
          externalDispatchCount,
        ).toBe(1);

        const workflowIds = [
          ...dispatchA.mock.calls,
          ...dispatchB.mock.calls,
          ...dispatchC.mock.calls,
        ].map(
          ([input]) =>
            input.workflowId ??
            `icos-task-${input.taskId}`,
        );

        expect(workflowIds).toHaveLength(1);

        expect(workflowIds[0]).toBe(
          `icos-task-${missionTask.taskId}`,
        );
      },
    );
  },
);
