import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { executionCompletedBodySchema } from "@/server/http/execution-schemas";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { getContainer } from "@/server/container";
import { verifyExecutionCallback } from "@/server/execution/callback-auth";
import { apiError, json, readJson } from "@/server/http/respond";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository, TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { QualityControlRepository } from "@/core/contracts/quality-control";

// Canonical Vitest ESM mocking: vi.mock() is hoisted above imports by Vitest's
// transform, so the modules below are replaced before route.ts (which imports
// them too) ever resolves them. This replaces the previous require()-based
// spying, which failed at runtime ("Cannot find module '@/server/container'")
// because require() does not participate in Vitest's ESM module graph/alias
// resolution the way `vi.mock` + a real `import` does.
vi.mock("@/server/container", () => ({
  getContainer: vi.fn(),
}));
vi.mock("@/server/execution/callback-auth", () => ({
  verifyExecutionCallback: vi.fn(),
}));
vi.mock("@/server/http/respond", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/http/respond")>();
  return {
    ...actual,
    readJson: vi.fn(),
    json: vi.fn(actual.json),
    apiError: vi.fn(actual.apiError),
  };
});
vi.mock("@/server/usecases/record-task-execution", () => ({
  recordTaskExecution: vi.fn(),
}));
vi.mock("@/server/usecases/record-mission-task-execution", () => ({
  recordMissionTaskExecution: vi.fn(),
}));
vi.mock("@/server/supervisor/supervisor-service", () => ({
  SupervisorService: vi.fn(function SupervisorServiceMock(this: unknown) {
    return this;
  }),
}));

/** Partial-but-typed MissionRepository mock: only the members this route path touches. */
function makeMissionRepositoryMock(overrides: Partial<MissionRepository> = {}): MissionRepository {
  return {
    list: vi.fn(),
    listForScope: vi.fn(),
    getById: vi.fn(),
    getByIdForScope: vi.fn(),
    create: vi.fn(),
    listTasks: vi.fn(),
    getMissionIdByTaskId: vi.fn(),
    ...overrides,
  } as unknown as MissionRepository;
}

function makeContainer(overrides: any = {}): any {
  return {
    executionCallbackSecret: undefined,
    tasks: {} as TaskRepository,
    executionResults: {
      getByWorkflowId: vi.fn().mockResolvedValue({ id: "execution-result-id" }),
      getByTaskId: vi.fn().mockResolvedValue(null),
      listByTaskIds: vi.fn().mockResolvedValue([]),
      record: vi.fn().mockResolvedValue({
        ok: true,
        record: {
          id: "execution-result-id",
          taskId: "task1",
          workflowId: "wf1",
          outcome: "success",
          completedAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
        } as any,
        duplicate: false,
      }),
    } as TaskExecutionResultRepository,
    mission: makeMissionRepositoryMock(),
    taskExecution: {} as any,
    reviewer: undefined as any,
    reviewDecisions: undefined as any,
    qualityControlJobs: {
      register: vi.fn().mockResolvedValue(undefined),
    } as any,
    dispatchAttempts: {
      getByWorkflowId: vi.fn().mockResolvedValue({
        missionId: "mission1",
        missionTaskId: "mission-task1",
        taskId: "task1",
        attempt: 1,
      }),
    } as any,
    ...overrides,
  };
}

describe("POST /api/internal/executions/completed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should call recordTaskExecution and register for quality control (fire-and-forget) when not duplicate", async () => {
    const missionRepository = makeMissionRepositoryMock({
      getMissionTaskByCanonicalTaskId: vi.fn().mockResolvedValue({
        id: "mission-task1",
        missionId: "mission1",
      }),
    });
    const mockContainer = makeContainer({
      executionCallbackSecret: "test-secret",
      mission: missionRepository,
      qualityControlJobs: {
        register: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.mocked(getContainer).mockResolvedValue(mockContainer);
    vi.mocked(verifyExecutionCallback).mockReturnValue({ ok: true });

    const mockReadJson = { ok: true as const, value: {} };
    vi.mocked(readJson).mockResolvedValue(mockReadJson);

    const parsedData = {
      taskId: "task1",
      workflowId: "wf1",
      outcome: "success" as const,
      completedAt: new Date().toISOString(),
    };
    const mockParse = {
      success: true as const,
      data: parsedData,
    } satisfies ReturnType<typeof executionCompletedBodySchema.safeParse>;
    vi.spyOn(executionCompletedBodySchema, "safeParse").mockReturnValue(mockParse);

    const mockRecordTaskResult = {
      ok: true as const,
      record: {} as Awaited<ReturnType<TaskExecutionResultRepository["record"]>> extends {
        record: infer R;
      }
        ? R
        : never,
      duplicate: false,
    };
    vi.mocked(recordTaskExecution).mockResolvedValue(mockRecordTaskResult);

    const mockSupervisor = { run: vi.fn() };
    vi.mocked(SupervisorService).mockImplementation(function (this: unknown) {
      return mockSupervisor as unknown as SupervisorService;
    });

    const mockJson = new Response(JSON.stringify({ json: {} }), { status: 200 });
    vi.mocked(json).mockReturnValue(mockJson);

    const request = new Request("http://localhost/api/internal/executions/completed", {
      method: "POST",
    });
    const response = await POST(request);

    expect(getContainer).toHaveBeenCalled();
    expect(recordTaskExecution).toHaveBeenCalledWith(
      {
        tasks: mockContainer.tasks,
        executionResults: mockContainer.executionResults,
        missions: mockContainer.mission,
        durableMemory: mockContainer.durableMemory,
        dispatchAttempts: mockContainer.dispatchAttempts,
      },
      mockParse.data,
    );
    /* P0 2026-09-30: the HTTP layer constructs NO supervisor — not even an unused one. */
    expect(SupervisorService).not.toHaveBeenCalled();
    // We do not expect recordMissionTaskExecution to be called in the callback anymore.
    // Instead, we expect the quality control registration to be attempted (fire-and-forget).
    // Since we mocked the qualityControlJobs.register, we can check that it was called.
    // However, note that the qualityControl instance is created inside the route and we cannot directly spy on it.
    // We can check that the mock for qualityControlJobs.register was called.
    // But note: the mockContainer.qualityControlJobs.register is a mock that we set up in makeContainer.
    // We expect it to have been called with the registration data.
    // However, the registration is done via `void qualityControl.registerExecution(...)`, which returns a promise.
    // We cannot await it in the test because it's fire-and-forget, but we can wait for the next tick.
    // Alternatively, we can change the test to wait for the promise to resolve by using a fake timer or by awaiting the route.
    // Since the route returns before the registration promise resolves, we need to wait for the microtick.
    // We'll do: after awaiting the route, we wait for the next tick and then check the mock.
    // But note: the route already awaited the recordTaskExecution and then fired the registration and returned.
    // So we can do:
    await Promise.resolve(); // wait for the microtask where the fire-and-forget promise is scheduled.
    expect(mockContainer.qualityControlJobs.register).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission1",
        missionTaskId: "mission-task1",
        taskId: "task1",
        workflowId: "wf1",
        executionResultId: "execution-result-id",
        executionAttempt: 1,
      }),
    );

    expect(response).toBe(mockJson);
  });

  it("should replay mission review recovery when execution result is duplicate", async () => {
    const missionRepository = makeMissionRepositoryMock({
      getMissionTaskByCanonicalTaskId: vi.fn().mockResolvedValue({
        id: "mission-task1",
        missionId: "mission1",
      }),
    });
    const mockContainer = makeContainer({
      executionCallbackSecret: "test-secret",
      mission: missionRepository,
      qualityControlJobs: {
        register: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.mocked(getContainer).mockResolvedValue(mockContainer);
    vi.mocked(verifyExecutionCallback).mockReturnValue({ ok: true });

    const mockReadJson = { ok: true as const, value: {} };
    vi.mocked(readJson).mockResolvedValue(mockReadJson);

    const parsedData = {
      taskId: "task1",
      workflowId: "wf1",
      outcome: "success" as const,
      completedAt: new Date().toISOString(),
    };
    const mockParse = {
      success: true as const,
      data: parsedData,
    } satisfies ReturnType<typeof executionCompletedBodySchema.safeParse>;
    vi.spyOn(executionCompletedBodySchema, "safeParse").mockReturnValue(mockParse);

    const mockRecordTaskResult = {
      ok: true as const,
      record: {} as Awaited<ReturnType<TaskExecutionResultRepository["record"]>> extends {
        record: infer R;
      }
        ? R
        : never,
      duplicate: true,
    };
    vi.mocked(recordTaskExecution).mockResolvedValue(mockRecordTaskResult);

    const mockSupervisor = { run: vi.fn() };
    vi.mocked(SupervisorService).mockImplementation(function (this: unknown) {
      return mockSupervisor as unknown as SupervisorService;
    });

    const mockJson = new Response(JSON.stringify({ json: {} }), { status: 200 });
    vi.mocked(json).mockReturnValue(mockJson);

    const request = new Request("http://localhost/api/internal/executions/completed", {
      method: "POST",
    });
    const response = await POST(request);

    expect(recordTaskExecution).toHaveBeenCalled();
    // We do not expect recordMissionTaskExecution to be called in the callback anymore.
    // Instead, we expect the quality control registration to be attempted (fire-and-forget).
    await Promise.resolve(); // wait for the microtask
    expect(mockContainer.qualityControlJobs.register).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission1",
        missionTaskId: "mission-task1",
        taskId: "task1",
        workflowId: "wf1",
        executionResultId: "execution-result-id",
        executionAttempt: 1,
      }),
    );

    expect(mockSupervisor.run).not.toHaveBeenCalled();
    expect(response).toBe(mockJson);
  });

  it("should return error when callback auth fails", async () => {
    const mockContainer = makeContainer({ executionCallbackSecret: "test-secret" });
    vi.mocked(getContainer).mockResolvedValue(mockContainer);
    vi.mocked(verifyExecutionCallback).mockReturnValue({ ok: false, reason: "missing" });

    const mockApiError = new Response(JSON.stringify({ error: {} }), { status: 401 });
    vi.mocked(apiError).mockReturnValue(mockApiError);

    const request = new Request("http://localhost/api/internal/executions/completed", {
      method: "POST",
    });
    const response = await POST(request);

    expect(apiError).toHaveBeenCalledWith("unauthenticated", "callback non autorisé");
    expect(response).toBe(mockApiError);
  });

  it("fails closed before persistence for an unknown workflow", async () => {
    const mockContainer = makeContainer({
      executionCallbackSecret: "test-secret",
      dispatchAttempts: {
        getByWorkflowId: vi.fn().mockResolvedValue(null),
      } as any,
    });
    vi.mocked(getContainer).mockResolvedValue(mockContainer);
    vi.mocked(verifyExecutionCallback).mockReturnValue({ ok: true });
    vi.mocked(readJson).mockResolvedValue({ ok: true, value: {} });
    vi.spyOn(executionCompletedBodySchema, "safeParse").mockReturnValue({
      success: true,
      data: {
        taskId: "task1",
        workflowId: "unknown",
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    });

    await POST(
      new Request("http://localhost/api/internal/executions/completed", {
        method: "POST",
      }),
    );

    /* And WHICH invariant refused: the two shared one message, which is what made a
     * refused callback unreadable from the worker side. */
    expect(apiError).toHaveBeenCalledWith("invalid_input", "workflow d'exécution non corrélé", {
      reason: "EXECUTION_ATTEMPT_UNKNOWN",
    });
    expect(recordTaskExecution).not.toHaveBeenCalled();
  });

  it("fails closed when workflow mission/task correlation conflicts", async () => {
    const missionRepository = makeMissionRepositoryMock({
      getMissionTaskByCanonicalTaskId: vi.fn().mockResolvedValue({
        id: "different-mission-task",
        missionId: "mission1",
      }),
    });
    const mockContainer = makeContainer({
      executionCallbackSecret: "test-secret",
      mission: missionRepository,
    });
    vi.mocked(getContainer).mockResolvedValue(mockContainer);
    vi.mocked(verifyExecutionCallback).mockReturnValue({ ok: true });
    vi.mocked(readJson).mockResolvedValue({ ok: true, value: {} });
    vi.spyOn(executionCompletedBodySchema, "safeParse").mockReturnValue({
      success: true,
      data: {
        taskId: "task1",
        workflowId: "wf1",
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    });
    await POST(
      new Request("http://localhost/api/internal/executions/completed", {
        method: "POST",
      }),
    );

    /* The MISSION-TASK invariant, told apart from the attempt one. */
    expect(apiError).toHaveBeenCalledWith("invalid_input", "workflow d'exécution non corrélé", {
      reason: "MISSION_TASK_ATTEMPT_MISMATCH",
    });
    expect(recordTaskExecution).not.toHaveBeenCalled();
  });
});