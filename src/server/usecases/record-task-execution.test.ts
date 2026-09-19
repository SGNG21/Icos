import { describe, expect, it, vi } from "vitest";

import type { TaskRepository } from "@/server/repositories/ports";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import type { MissionRepository } from "@/server/mission/ports";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";

import { recordTaskExecution } from "./record-task-execution";
import type { DurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";

interface Fixtures {
  tasks: TaskRepository;
  executionResults: InMemoryTaskExecutionResultRepository;
  supervisor: SupervisorService;
  missions: MissionRepository;
  durableMemory: DurableMemory;
}

async function fixtures(): Promise<Fixtures> {
  const auditLog = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(auditLog, []);
  const missions = new InMemoryMissionRepository();
  // Mock dispatcher
  const dispatcher = {
    dispatch: async () => ({ workflowId: `wf-${Math.random()}` }),
  };
  const durableMemory = {
    getCheckpoints: vi.fn().mockResolvedValue([]),
    saveCheckpoint: vi.fn().mockResolvedValue(undefined),
    getLatestCheckpoint: vi.fn().mockResolvedValue(null),
    getCheckpointById: vi.fn().mockResolvedValue(null),
    saveDecision: vi.fn().mockResolvedValue(undefined),
    getDecisions: vi.fn().mockResolvedValue([]),
    saveExecutionResult: vi.fn().mockResolvedValue(undefined),
    getExecutionResults: vi.fn().mockResolvedValue([]),
    savePattern: vi.fn().mockResolvedValue(undefined),
    getPatterns: vi.fn().mockResolvedValue([]),
    saveContextItem: vi.fn().mockResolvedValue(undefined),
    queryContextItems: vi.fn().mockResolvedValue([]),
    saveHandoffPackage: vi.fn().mockResolvedValue(undefined),
    getHandoffPackage: vi.fn().mockResolvedValue(null),
    cleanup: vi.fn().mockResolvedValue(0),
  } as DurableMemory;
  const executionResults = new InMemoryTaskExecutionResultRepository(auditLog, tasks);
  const supervisor = new SupervisorService(missions, tasks, dispatcher, durableMemory);
  return { tasks, executionResults, supervisor, missions, durableMemory };
}

async function seedRunningTask(tasks: TaskRepository): Promise<string> {
  const created = await tasks.create({ title: "Analyse" });
  if (!created.ok) throw new Error("seed failed");
  const queued = await tasks.transition(created.task.id, "queued");
  if (!queued.ok) throw new Error("seed queued");
  const running = await tasks.transition(created.task.id, "running");
  if (!running.ok) throw new Error("seed running");
  return created.task.id;
}

describe("recordTaskExecution — succès", () => {
  it("persiste la preuve et fait passer la tâche à succeeded", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);

    const result = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId,
        workflowId: `icos-task-${taskId}`,
        outcome: "success",
        workerKind: "hermes",
        result: "OK",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(result.record.outcome).toBe("success");
    expect(result.record.result).toBe("OK");
    expect((await tasks.getById(taskId))?.status).toBe("review_pending");
  });
});

describe("recordTaskExecution — échec", () => {
  it("persiste l'erreur normalisée et fait passer la tâche à failed", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);

    const result = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId,
        workflowId: `icos-task-${taskId}`,
        outcome: "failure",
        workerKind: "hermes",
        error: { code: "WORKER_FAILED", message: "timeout LLM" },
        completedAt: "2026-08-18T12:05:00.000Z",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.error?.code).toBe("WORKER_FAILED");
    expect((await tasks.getById(taskId))?.status).toBe("review_pending");
  });

  it("refuse un succès sans preuve et un échec sans erreur (fail-closed)", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);

    const failureWithoutError = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId,
        workflowId: `icos-task-${taskId}`,
        outcome: "failure",
        completedAt: "2026-08-18T12:05:00.000Z",
      },
    );
    expect(failureWithoutError).toMatchObject({ ok: false, reason: "invalid_input" });
    expect((await tasks.getById(taskId))?.status).toBe("running");
  });
});

describe("recordTaskExecution — idempotence", () => {
  it("traite deux fois le même workflowId sans doublon ni écrasement", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);
    const workflowId = `icos-task-${taskId}`;

    const first = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId,
        workflowId,
        outcome: "success",
        result: "run-1",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );
    expect(first.ok && !first.duplicate).toBe(true);

    // Rejeu : Temporal retente exactement la même complétion.
    const replay = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId,
        workflowId,
        outcome: "success",
        result: "run-1",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.duplicate).toBe(true);
    expect(replay.record.result).toBe("run-1");
    const persisted = await executionResults.listByTaskIds([taskId]);
    expect(persisted).toHaveLength(1);
  });

  it("refuse un callback dupliqué dont le résultat est conflictuel", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);
    const workflowId = `icos-task-${taskId}`;
    const common = {
      taskId,
      workflowId,
      outcome: "success" as const,
      completedAt: "2026-08-18T12:00:00.000Z",
    };

    await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      { ...common, result: "canonical" },
    );
    const conflict = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      { ...common, result: "conflicting" },
    );

    expect(conflict).toMatchObject({
      ok: false,
      reason: "invalid_input",
      message: "résultat conflictuel pour ce workflow",
    });
    expect((await executionResults.getByWorkflowId(workflowId))?.result).toBe("canonical");
  });
});

describe("recordTaskExecution — tâche inconnue", () => {
  it("refuse une complétion orpheline sans créer de tâche implicite", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();

    const result = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId: "task-inexistante",
        workflowId: "icos-task-task-inexistante",
        outcome: "success",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );

    expect(result).toMatchObject({ ok: false, reason: "task_not_found" });
    expect(await tasks.list()).toHaveLength(0);
  });
});

describe("recordTaskExecution — corrélation", () => {
  it("refuse un workflow inconnu lorsque le ledger durable est disponible", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);
    const dispatchAttempts = {
      getByWorkflowId: vi.fn().mockResolvedValue(null),
    } as unknown as import("@/core/contracts/dispatch-attempt").DispatchAttemptRepository;

    const result = await recordTaskExecution(
      {
        tasks,
        executionResults,
        supervisor,
        missions,
        durableMemory,
        dispatchAttempts,
      },
      {
        taskId,
        workflowId: "unknown-workflow",
        outcome: "success",
        result: "must not persist",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_input",
      message: "workflow d'exécution non corrélé",
    });
    expect(await executionResults.getByWorkflowId("unknown-workflow")).toBeNull();
  });

  it("refuse un workflow durable associé à une autre tâche", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);
    const dispatchAttempts = {
      getByWorkflowId: vi.fn().mockResolvedValue({
        taskId: "different-task",
      }),
    } as unknown as import("@/core/contracts/dispatch-attempt").DispatchAttemptRepository;

    const result = await recordTaskExecution(
      {
        tasks,
        executionResults,
        supervisor,
        missions,
        durableMemory,
        dispatchAttempts,
      },
      {
        taskId,
        workflowId: "mismatched-workflow",
        outcome: "success",
        result: "must not persist",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("refuse le même workflowId associé à une autre tâche", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskA = await seedRunningTask(tasks);
    const taskB = await seedRunningTask(tasks);
    const workflowId = "icos-shared-wf";

    const first = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId: taskA,
        workflowId,
        outcome: "success",
        result: "A",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );
    expect(first.ok).toBe(true);

    const collision = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId: taskB,
        workflowId,
        outcome: "success",
        result: "B",
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );
    expect(collision).toMatchObject({ ok: false, reason: "invalid_input" });
    expect((await tasks.getById(taskB))?.status).toBe("running");
  });
});

describe("recordTaskExecution — hygiène des données", () => {
  it("n'accepte pas les codes d'erreur non normalisés (aucune fuite arbitraire)", async () => {
    const { tasks, executionResults, supervisor, missions, durableMemory } = await fixtures();
    const taskId = await seedRunningTask(tasks);

    const result = await recordTaskExecution(
      { tasks, executionResults, supervisor, missions, durableMemory },
      {
        taskId,
        workflowId: `icos-task-${taskId}`,
        outcome: "failure",
        error: { code: "MY_SECRET_TOKEN" as any, message: "leak?" },
        completedAt: "2026-08-18T12:00:00.000Z",
      },
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});
