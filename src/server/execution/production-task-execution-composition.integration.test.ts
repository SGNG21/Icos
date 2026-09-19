import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { describe, expect, it } from "vitest";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer } from "@/server/container";
import { InMemoryTaskExecutionDispatcher } from "@/server/execution/in-memory-task-execution-dispatcher";
import { TemporalTaskExecutionDispatcher } from "@/server/execution/temporal-task-execution-dispatcher";

const DATABASE_URL = TEST_DATABASE_URL;

describe("production task execution composition", () => {
  it("selects the real Temporal dispatcher for PostgreSQL production", async () => {
    const previousBaseUrl = process.env.OMNIROUTE_BASE_URL;
    const previousApiKey = process.env.OMNIROUTE_API_KEY;
    const previousReviewerModel = process.env.ICOS_REVIEWER_MODEL;
    process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:65535";
    process.env.OMNIROUTE_API_KEY = "phase-4-test-key";
    process.env.ICOS_REVIEWER_MODEL = "phase-4-reviewer";

    const env = loadEnv({
      NODE_ENV: "production",
      PERSISTENCE: "postgres",
      DATABASE_URL,
      TEMPORAL_ADDRESS: "127.0.0.1:65535",
      TEMPORAL_TASK_QUEUE: "icos-phase-4",
      TEMPORAL_WORKFLOW_TYPE: "runIcosTask",
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "phase-4-test-key",
      ICOS_REVIEWER_MODEL: "phase-4-reviewer",
    });
    let container;

    try {
      container = await buildPostgresContainer(DATABASE_URL, undefined, env);
      expect(container.taskExecution).toBeInstanceOf(TemporalTaskExecutionDispatcher);
      expect(container.taskExecution).not.toBeInstanceOf(InMemoryTaskExecutionDispatcher);
    } finally {
      await container?.close();
      if (previousBaseUrl === undefined) {
        delete process.env.OMNIROUTE_BASE_URL;
      } else {
        process.env.OMNIROUTE_BASE_URL = previousBaseUrl;
      }
      if (previousApiKey === undefined) {
        delete process.env.OMNIROUTE_API_KEY;
      } else {
        process.env.OMNIROUTE_API_KEY = previousApiKey;
      }
      if (previousReviewerModel === undefined) {
        delete process.env.ICOS_REVIEWER_MODEL;
      } else {
        process.env.ICOS_REVIEWER_MODEL = previousReviewerModel;
      }
    }
  });

  it("fails closed when the OmniRoute reviewer is not configured for PostgreSQL", async () => {
    const env = loadEnv({
      NODE_ENV: "production",
      PERSISTENCE: "postgres",
      DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "phase-4-test-key",
      // no ICOS_REVIEWER_MODEL
    });
    await expect(buildPostgresContainer(DATABASE_URL, undefined, env)).rejects.toThrow(
      "Le reviewer OmniRoute est requis pour le backend PostgreSQL.",
    );
  });
});
