import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import { sql } from "drizzle-orm";

import {
  buildPostgresContainer,
  type Container,
} from "@/server/container";

import {
  auditEntries,
  missionTasks,
  missions,
  tasks,
} from "@/server/database/schema";

const DATABASE_URL =
  "postgres://coco@localhost:5432/icos_n23_probe";

process.env.OMNIROUTE_BASE_URL ??=
  "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??=
  "n2-7-plan-test-key";
process.env.ICOS_REVIEWER_MODEL ??=
  "n2-7-plan-test-model";
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
  if (!opened.has(container)) {
    return;
  }

  opened.delete(container);
  await container.close();
}

describe(
  "N2.7 atomic MissionPlan application",
  () => {
    afterEach(async () => {
      for (const container of [...opened]) {
        await shutdown(container);
      }
    });

    it(
      "atomically creates canonical Tasks, audits and a resolved MissionTask DAG",
      async () => {
        const container =
          await freshProcess();

        if (!container.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        await container.db.execute(
          sql.raw(
            "TRUNCATE TABLE missions, tasks " +
              "RESTART IDENTITY CASCADE",
          ),
        );

        /*
         * Create an EMPTY mission.
         *
         * Planner output is applied afterwards.
         */
        const mission =
          await container.mission.create({
            title:
              "N2.7 Autonomous Plan",
            objective:
              "Plan then execute autonomously",
            tasks: [],
          });

        const applied =
          await container.mission.applyPlan(
            mission.id,
            {
              version: 1,
              tasks: [
                {
                  key: "A",
                  title:
                    "N2.7 PLAN A",
                  description:
                    "Discover",
                  dependsOn: [],
                  workerKind: "agent",
                },
                {
                  key: "B",
                  title:
                    "N2.7 PLAN B",
                  description:
                    "Implement",
                  dependsOn: ["A"],
                  workerKind: "agent",
                },
                {
                  key: "C",
                  title:
                    "N2.7 PLAN C",
                  description:
                    "Verify",
                  dependsOn: [
                    "A",
                    "B",
                  ],
                  workerKind: "agent",
                },
              ],
            },
          );

        expect(applied).toHaveLength(3);

        const a = applied.find(
          (task) =>
            task.title === "N2.7 PLAN A",
        );
        const b = applied.find(
          (task) =>
            task.title === "N2.7 PLAN B",
        );
        const c = applied.find(
          (task) =>
            task.title === "N2.7 PLAN C",
        );

        if (!a || !b || !c) {
          throw new Error(
            "Applied plan tasks missing",
          );
        }

        /*
         * Planner keys MUST NOT leak into persistence.
         *
         * dependsOn uses MissionTask.id.
         */
        expect(a.dependsOn).toEqual([]);
        expect(b.dependsOn).toEqual([
          a.id,
        ]);
        expect(c.dependsOn).toEqual([
          a.id,
          b.id,
        ]);

        /*
         * Canonical Task IDs remain distinct from MissionTask IDs.
         */
        expect(a.taskId).not.toBe(a.id);
        expect(b.taskId).not.toBe(b.id);
        expect(c.taskId).not.toBe(c.id);

        const persistedMissionTasks =
          await container.db
            .select()
            .from(missionTasks)
            .where(
              sql`${missionTasks.missionId} = ${mission.id}`,
            );

        expect(
          persistedMissionTasks,
        ).toHaveLength(3);

        const taskRows =
          await container.db
            .select()
            .from(tasks)
            .where(
              sql`${tasks.title} LIKE 'N2.7 PLAN %'`,
            );

        expect(taskRows).toHaveLength(3);

        const audits =
          await container.db
            .select()
            .from(auditEntries)
            .where(
              sql`${auditEntries.eventType} = 'task.created'`,
            );

        /*
         * DB is truncated at test start, so exactly three
         * task.created audits must exist.
         */
        expect(audits).toHaveLength(3);
      },
    );

    it(
      "fails closed when a plan is applied twice",
      async () => {
        const container =
          await freshProcess();

        if (!container.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        await container.db.execute(
          sql.raw(
            "TRUNCATE TABLE missions, tasks " +
              "RESTART IDENTITY CASCADE",
          ),
        );

        const mission =
          await container.mission.create({
            title:
              "N2.7 Plan Once",
            objective:
              "Reject accidental duplicate plan application",
            tasks: [],
          });

        const plan = {
          version: 1,
          tasks: [
            {
              key: "A",
              title:
                "N2.7 PLAN ONCE A",
              description: "A",
              dependsOn: [],
              workerKind: "agent",
            },
          ],
        };

        await container.mission.applyPlan(
          mission.id,
          plan,
        );

        await expect(
          container.mission.applyPlan(
            mission.id,
            plan,
          ),
        ).rejects.toThrow(
          "MISSION_PLAN_ALREADY_APPLIED",
        );

        const stored =
          await container.mission.listTasks(
            mission.id,
          );

        expect(stored).toHaveLength(1);
      },
    );

    it(
      "does not persist anything when plan validation fails",
      async () => {
        const container =
          await freshProcess();

        if (!container.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        await container.db.execute(
          sql.raw(
            "TRUNCATE TABLE missions, tasks " +
              "RESTART IDENTITY CASCADE",
          ),
        );

        const mission =
          await container.mission.create({
            title:
              "N2.7 Invalid Plan",
            objective:
              "Invalid graph must fail closed",
            tasks: [],
          });

        await expect(
          container.mission.applyPlan(
            mission.id,
            {
              version: 1,
              tasks: [
                {
                  key: "A",
                  title:
                    "N2.7 INVALID A",
                  description: "A",
                  dependsOn: ["MISSING"],
                  workerKind: "agent",
                },
              ],
            },
          ),
        ).rejects.toThrow(
          "MISSION_PLAN_UNKNOWN_DEPENDENCY",
        );

        const stored =
          await container.mission.listTasks(
            mission.id,
          );

        expect(stored).toHaveLength(0);

        const canonical =
          await container.db
            .select()
            .from(tasks)
            .where(
              sql`${tasks.title} = 'N2.7 INVALID A'`,
            );

        expect(canonical).toHaveLength(0);
      },
    );
  },
);
