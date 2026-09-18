import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { sql } from "drizzle-orm";

import {
  buildPostgresContainer,
  type Container,
} from "@/server/container";

const DATABASE_URL =
  TEST_DATABASE_URL;

// buildPostgresContainer constructs PostgresReviewerService even though
// this test only exercises MissionRepository.create().
process.env.OMNIROUTE_BASE_URL ??=
  "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??=
  "n2-7-atomicity-test-key";
process.env.ICOS_REVIEWER_MODEL ??=
  "n2-7-atomicity-test-model";
process.env.ICOS_REVIEWER_TIMEOUT_MS ??=
  "1000";

describe(
  "N2.7-0.c PostgreSQL atomic mission creation",
  () => {
    let container: Container;

    beforeAll(async () => {
      container =
        await buildPostgresContainer(DATABASE_URL);

      if (!container.db) {
        throw new Error(
          "PostgreSQL db handle unavailable",
        );
      }

      // Disposable DB only.
      await container.db.execute(
        sql.raw(
          "TRUNCATE TABLE missions, tasks " +
            "RESTART IDENTITY CASCADE",
        ),
      );

      /*
       * Failure injector.
       *
       * Only MissionTasks whose title begins with the explicit
       * N2.7 marker fail. Normal repository writes remain untouched.
       */
      await container.db.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION
          n27_atomicity_fail_mission_task()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.title LIKE 'N2.7 ATOMIC FAIL%' THEN
            RAISE EXCEPTION
              'N2.7 injected mission_tasks failure';
          END IF;

          RETURN NEW;
        END;
        $$;
      `));

      await container.db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS
          n27_atomicity_failure_trigger
        ON mission_tasks;
      `));

      await container.db.execute(sql.raw(`
        CREATE TRIGGER
          n27_atomicity_failure_trigger
        BEFORE INSERT ON mission_tasks
        FOR EACH ROW
        EXECUTE FUNCTION
          n27_atomicity_fail_mission_task();
      `));
    });

    afterAll(async () => {
      if (!container) {
        return;
      }

      if (container.db) {
        await container.db.execute(sql.raw(`
          DROP TRIGGER IF EXISTS
            n27_atomicity_failure_trigger
          ON mission_tasks;
        `));

        await container.db.execute(sql.raw(`
          DROP FUNCTION IF EXISTS
            n27_atomicity_fail_mission_task();
        `));

        // Disposable DB:
        // TRUNCATE CASCADE is intentional because audit_entries
        // is append-only for normal DML and must never be DELETEd.
        await container.db.execute(
          sql.raw(
            "TRUNCATE TABLE missions, tasks " +
              "RESTART IDENTITY CASCADE",
          ),
        );
      }

      await container.close();
    });

    it(
      "commits canonical Tasks, audits, Mission and MissionTasks together",
      async () => {
        if (!container.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        const mission =
          await container.mission.create({
            title:
              "N2.7 ATOMIC SUCCESS MISSION",
            objective:
              "Repository transaction success proof",
            tasks: [
              {
                title:
                  "N2.7 ATOMIC SUCCESS TASK A",
                description:
                  "Atomic success A",
                dependsOn: [],
                workerKind: "agent",
                capability:
                  "test.atomic.success",
              },
              {
                title:
                  "N2.7 ATOMIC SUCCESS TASK B",
                description:
                  "Atomic success B",
                dependsOn: [],
                workerKind: "agent",
                capability:
                  "test.atomic.success",
              },
            ],
          });

        const missionTasks =
          await container.mission.listTasks(
            mission.id,
          );

        expect(missionTasks).toHaveLength(2);

        const counts =
          await container.db.execute(sql.raw(`
            SELECT
              (
                SELECT count(*)::int
                FROM missions
                WHERE title =
                  'N2.7 ATOMIC SUCCESS MISSION'
              ) AS missions,

              (
                SELECT count(*)::int
                FROM mission_tasks
                WHERE title LIKE
                  'N2.7 ATOMIC SUCCESS TASK%'
              ) AS mission_tasks,

              (
                SELECT count(*)::int
                FROM tasks
                WHERE title LIKE
                  'N2.7 ATOMIC SUCCESS TASK%'
              ) AS tasks,

              (
                SELECT count(*)::int
                FROM audit_entries
                WHERE event_type = 'task.created'
                  AND details->>'title' LIKE
                    'N2.7 ATOMIC SUCCESS TASK%'
              ) AS audits;
          `));

        const row = counts[0] as {
          missions: number;
          mission_tasks: number;
          tasks: number;
          audits: number;
        };

        expect(row).toEqual({
          missions: 1,
          mission_tasks: 2,
          tasks: 2,
          audits: 2,
        });
      },
    );

    it(
      "rolls back Tasks, audits and Mission when MissionTask insert fails",
      async () => {
        if (!container.db) {
          throw new Error(
            "PostgreSQL db handle unavailable",
          );
        }

        await expect(
          container.mission.create({
            title:
              "N2.7 ATOMIC FAIL MISSION",
            objective:
              "Repository rollback proof",
            tasks: [
              {
                title:
                  "N2.7 ATOMIC FAIL TASK A",
                description:
                  "Must disappear after rollback",
                dependsOn: [],
                workerKind: "agent",
                capability:
                  "test.atomic.failure",
              },
              {
                title:
                  "N2.7 ATOMIC FAIL TASK B",
                description:
                  "Must disappear after rollback",
                dependsOn: [],
                workerKind: "agent",
                capability:
                  "test.atomic.failure",
              },
            ],
          }),
        ).rejects.toThrow();

        const counts =
          await container.db.execute(sql.raw(`
            SELECT
              (
                SELECT count(*)::int
                FROM missions
                WHERE title =
                  'N2.7 ATOMIC FAIL MISSION'
              ) AS missions,

              (
                SELECT count(*)::int
                FROM mission_tasks
                WHERE title LIKE
                  'N2.7 ATOMIC FAIL TASK%'
              ) AS mission_tasks,

              (
                SELECT count(*)::int
                FROM tasks
                WHERE title LIKE
                  'N2.7 ATOMIC FAIL TASK%'
              ) AS tasks,

              (
                SELECT count(*)::int
                FROM audit_entries
                WHERE event_type = 'task.created'
                  AND details->>'title' LIKE
                    'N2.7 ATOMIC FAIL TASK%'
              ) AS audits;
          `));

        const row = counts[0] as {
          missions: number;
          mission_tasks: number;
          tasks: number;
          audits: number;
        };

        expect(row).toEqual({
          missions: 0,
          mission_tasks: 0,
          tasks: 0,
          audits: 0,
        });
      },
    );
  },
);
