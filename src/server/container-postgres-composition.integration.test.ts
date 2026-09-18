import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "@/config/env";
import {
  buildPostgresContainer,
  createContainer,
  type Container,
} from "@/server/container";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import { PostgresAutonomousMissionRuntimeRepository } from "@/server/repositories/postgres/autonomous-mission-runtime-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PersistenceUnavailableError } from "@/server/database/errors";

const DATABASE_URL = TEST_DATABASE_URL;
const env = loadEnv({
  NODE_ENV: "test",
  PERSISTENCE: "postgres",
  DATABASE_URL,
  OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
  OMNIROUTE_API_KEY: "container-composition-test-key",
  ICOS_REVIEWER_MODEL: "container-composition-test-model",
});

describe("PostgreSQL container composition", () => {
  let container: Container;

  beforeAll(async () => {
    container = await buildPostgresContainer(DATABASE_URL, undefined, env);
  });

  afterAll(async () => {
    await container.close();
  });

  it("wires every critical component to PostgreSQL and exposes one shared handle", () => {
    expect(container.mission).toBeInstanceOf(PostgresMissionRepository);
    expect(container.tasks).toBeInstanceOf(PostgresTaskRepository);
    expect(container.audit).toBeInstanceOf(PostgresAuditRepository);
    expect(container.dispatchAttempts).toBeInstanceOf(PostgresDispatchAttemptRepository);
    expect(container.executionResults).toBeInstanceOf(PostgresTaskExecutionResultRepository);
    expect(container.reviewDecisions).toBeInstanceOf(PostgresReviewDecisionRepository);
    expect(container.qualityControlJobs).toBeInstanceOf(PostgresQualityControlRepository);
    expect(container.autonomousRuntime).toBeInstanceOf(
      PostgresAutonomousMissionRuntimeRepository,
    );
    expect(container.durableMemory).toBeInstanceOf(PostgresDurableMemory);
    expect(container.db).toBeDefined();

    for (const repository of [
      container.mission,
      container.tasks,
      container.audit,
      container.dispatchAttempts,
      container.executionResults,
      container.reviewDecisions,
      container.qualityControlJobs,
      container.autonomousRuntime,
      container.durableMemory,
    ]) {
      expect((repository as unknown as { db: unknown }).db).toBe(container.db);
    }
  });

  it("fails closed when PostgreSQL initialization fails", async () => {
    let resolved: Container | undefined;
    await expect(
      createContainer({
        env: loadEnv({
          NODE_ENV: "test",
          PERSISTENCE: "postgres",
          DATABASE_URL: "postgres://coco@127.0.0.1:1/icos_test",
          OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
          OMNIROUTE_API_KEY: "container-composition-test-key",
          ICOS_REVIEWER_MODEL: "container-composition-test-model",
        }),
      }).then((value) => {
        resolved = value;
        return value;
      }),
    ).rejects.toBeInstanceOf(PersistenceUnavailableError);
    expect(resolved).toBeUndefined();
  });
});
