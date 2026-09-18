import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import type { TaskExecutionResult } from "@/core/contracts";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import {
  auditEntries,
  taskExecutionResults,
  tasks,
} from "@/server/database/schema";
import { PostgresTaskExecutionResultRepository } from "./task-execution-result-repository";

const DATABASE_URL = TEST_DATABASE_URL;
const PREFIX = "proof-task-execution-result";
const TASK_ID = `${PREFIX}-task`;
const WORKFLOW_ID = `${PREFIX}-workflow`;

function input(overrides: Partial<Omit<TaskExecutionResult, "id" | "recordedAt">> = {}) {
  return {
    taskId: TASK_ID,
    workflowId: WORKFLOW_ID,
    outcome: "success" as const,
    workerKind: "digitalos" as const,
    capability: "website.build",
    digitalosExecutionId: "digitalos-execution-001",
    result: "canonical result",
    startedAt: "2026-09-16T10:00:00.000Z",
    completedAt: "2026-09-16T10:05:00.000Z",
    artifacts: [{ type: "preview", url: "https://example.test/preview" }],
    evidence: [
      {
        type: "report",
        source: "gate",
        timestamp: "2026-09-16T10:04:00.000Z",
        metadata: { passed: true },
      },
    ],
    findings: [{ severity: "PASS" as const, check: "build", message: "ok" }],
    ...overrides,
  };
}

describe("PostgresTaskExecutionResultRepository strict idempotence", () => {
  let handle: DatabaseHandle;
  let repository: PostgresTaskExecutionResultRepository;

  async function removeFixtures(): Promise<void> {
    await handle.db.execute(sql`SET session_replication_role = replica`);
    try {
      await handle.db.delete(auditEntries).where(eq(auditEntries.taskId, TASK_ID));
      await handle.db
        .delete(taskExecutionResults)
        .where(eq(taskExecutionResults.workflowId, WORKFLOW_ID));
      await handle.db.delete(tasks).where(eq(tasks.id, TASK_ID));
    } finally {
      await handle.db.execute(sql`SET session_replication_role = origin`);
    }
  }

  beforeAll(async () => {
    handle = createDatabase(DATABASE_URL, { max: 1 });
    repository = new PostgresTaskExecutionResultRepository(handle.db);
    await removeFixtures();
    await handle.db.insert(tasks).values({
      id: TASK_ID,
      title: "Strict idempotence proof",
      description: null,
      status: "running",
      assignedAgentId: null,
      createdAt: new Date("2026-09-16T09:59:00.000Z"),
      updatedAt: new Date("2026-09-16T10:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await removeFixtures();
    await handle.close();
  });

  it("accepts only an identical replay and preserves the complete proof", async () => {
    const first = await repository.record(input());
    expect(first).toMatchObject({ ok: true, duplicate: false });

    const replay = await repository.record(input());
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    expect(await repository.getByWorkflowId(WORKFLOW_ID)).toMatchObject(input());
  });

  it.each([
    ["result", { result: "different result" }],
    ["startedAt", { startedAt: "2026-09-16T10:00:01.000Z" }],
    ["completedAt", { completedAt: "2026-09-16T10:05:01.000Z" }],
    ["artifacts", { artifacts: [{ type: "preview", url: "https://example.test/other" }] }],
    [
      "evidence",
      {
        evidence: [
          {
            type: "report",
            source: "other-gate",
            timestamp: "2026-09-16T10:04:00.000Z",
          },
        ],
      },
    ],
    ["findings", { findings: [{ severity: "BLOCK", check: "build", message: "failed" }] }],
    ["capability", { capability: "website.qa" }],
    ["digitalosExecutionId", { digitalosExecutionId: "digitalos-execution-002" }],
  ])("rejects a replay whose %s differs", async (_field, override) => {
    const conflict = await repository.record(input(override as Parameters<typeof input>[0]));
    expect(conflict).toEqual({
      ok: false,
      reason: "invalid_input",
      message: "résultat conflictuel pour ce workflow",
    });
  });

  it("lets only one of two concurrent conflicting first writes become canonical", async () => {
    await removeFixtures();
    await handle.db.insert(tasks).values({
      id: TASK_ID,
      title: "Concurrent strict idempotence proof",
      description: null,
      status: "running",
      assignedAgentId: null,
      createdAt: new Date("2026-09-16T09:59:00.000Z"),
      updatedAt: new Date("2026-09-16T10:00:00.000Z"),
    });

    const [left, right] = await Promise.all([
      repository.record(input({ result: "left" })),
      repository.record(input({ result: "right" })),
    ]);

    expect([left, right].filter((result) => result.ok)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        reason: "invalid_input",
        message: "résultat conflictuel pour ce workflow",
      },
    ]);
    expect((await repository.listByTaskIds([TASK_ID]))).toHaveLength(1);
    expect((await repository.getByWorkflowId(WORKFLOW_ID))?.result).toMatch(/^(left|right)$/);
  });
});
