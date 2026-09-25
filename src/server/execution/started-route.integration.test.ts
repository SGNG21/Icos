import { describe, expect, it, vi } from "vitest";
import type { Task } from "@/core/contracts";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { TaskRepository } from "@/server/repositories/ports";
import { markTaskRunning } from "@/server/usecases/mark-task-running";

describe("markTaskRunning usecase", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "task-1",
    title: "Test Task",
    missionId: "mission-1",
    goalId: "goal-1",
    planId: "plan-1",
    objective: "Test Objective",
    instructions: "Test Instructions",
    dependencies: [],
    successCriteria: [],
    requiredCapabilities: [],
    riskClass: "reversible",
    allowedFileScope: [],
    expectedArtifacts: [],
    priority: 3,
    attemptBudget: 3,
    reviewPolicy: "if_risky",
    integrationPolicy: "",
    assignedAgentId: undefined,
    status: "draft",
    actionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  const makeDispatchAttempt = (overrides: Partial<DispatchAttempt> = {}): DispatchAttempt => ({
    id: "attempt-1",
    missionId: "mission-1",
    missionTaskId: "mission-task-1",
    taskId: "task-1",
    attempt: 1,
    workflowId: "workflow-1",
    prompt: "test",
    workerKind: "agent",
    capability: undefined,
    state: "prepared",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it("should start task when attempt is prepared and matches workflow", async () => {
    const taskRepo: TaskRepository = {
      getById: vi.fn().mockResolvedValue(makeTask({ status: "draft" })),
      transition: vi.fn().mockResolvedValue({ ok: true, task: makeTask({ status: "running" }) }),
    } as any;

    const attemptRepo: DispatchAttemptRepository = {
      getByWorkflowId: vi.fn().mockResolvedValue(makeDispatchAttempt()),
      listNonTerminalByMissionTaskId: vi.fn().mockResolvedValue([makeDispatchAttempt()]),
      authorizeStart: vi.fn().mockResolvedValue({ ok: true, task: makeTask({ status: "running" }), alreadyRunning: false }),
    } as any;

    const result = await markTaskRunning(
      { tasks: taskRepo, dispatchAttempts: attemptRepo },
      { taskId: "task-1", workflowId: "workflow-1" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.status).toBe("running");
      expect(result.alreadyRunning).toBe(false);
    }
    expect(attemptRepo.authorizeStart).toHaveBeenCalledWith("task-1", "workflow-1");
  });

  it("should return alreadyRunning when task is already running", async () => {
    const taskRepo: TaskRepository = {
      getById: vi.fn().mockResolvedValue(makeTask({ status: "running" })),
      transition: vi.fn(),
    } as any;

    const attemptRepo: DispatchAttemptRepository = {
      getByWorkflowId: vi.fn().mockResolvedValue(makeDispatchAttempt()),
      listNonTerminalByMissionTaskId: vi.fn().mockResolvedValue([makeDispatchAttempt()]),
      authorizeStart: vi.fn().mockResolvedValue({ ok: true, task: makeTask({ status: "running" }), alreadyRunning: true }),
    } as any;

    const result = await markTaskRunning(
      { tasks: taskRepo, dispatchAttempts: attemptRepo },
      { taskId: "task-1", workflowId: "workflow-1" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyRunning).toBe(true);
      expect(result.task.status).toBe("running");
    }
    expect(taskRepo.transition).not.toHaveBeenCalled();
  });

  it("should reject when task not found", async () => {
    const taskRepo: TaskRepository = {
      getById: vi.fn().mockResolvedValue(null),
      transition: vi.fn(),
    } as any;

    const attemptRepo: DispatchAttemptRepository = {
      getByWorkflowId: vi.fn().mockResolvedValue(makeDispatchAttempt()),
      listNonTerminalByMissionTaskId: vi.fn().mockResolvedValue([makeDispatchAttempt()]),
      authorizeStart: vi.fn().mockResolvedValue({ ok: false, reason: "task_not_found", message: "tâche inconnue : missing" }),
    } as any;

    const result = await markTaskRunning(
      { tasks: taskRepo, dispatchAttempts: attemptRepo },
      { taskId: "missing", workflowId: "workflow-1" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("task_not_found");
    }
  });

  it("should reject when workflow does not correlate to attempt", async () => {
    const taskRepo: TaskRepository = {
      getById: vi.fn().mockResolvedValue(makeTask()),
      transition: vi.fn(),
    } as any;

    const attemptRepo: DispatchAttemptRepository = {
      getByWorkflowId: vi.fn().mockResolvedValue(null),
      listNonTerminalByMissionTaskId: vi.fn().mockResolvedValue([]),
      authorizeStart: vi.fn().mockResolvedValue({ ok: false, reason: "workflow_not_found", message: "workflow d'exécution non corrélé" }),
    } as any;

    const result = await markTaskRunning(
      { tasks: taskRepo, dispatchAttempts: attemptRepo },
      { taskId: "task-1", workflowId: "wrong-workflow" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
      expect(result.message).toContain("workflow d'exécution non corrélé");
    }
  });

  it("should reject when stale attempt exists", async () => {
    const taskRepo: TaskRepository = {
      getById: vi.fn().mockResolvedValue(makeTask()),
      transition: vi.fn(),
    } as any;

    const attemptRepo: DispatchAttemptRepository = {
      getByWorkflowId: vi.fn().mockResolvedValue(makeDispatchAttempt({ attempt: 1 })),
      listNonTerminalByMissionTaskId: vi.fn().mockResolvedValue([
        makeDispatchAttempt({ attempt: 2 }), // newer attempt
        makeDispatchAttempt({ attempt: 1 }),
      ]),
      authorizeStart: vi.fn().mockResolvedValue({ ok: false, reason: "stale_attempt", message: "stale dispatch attempt: a newer attempt exists for this task" }),
    } as any;

    const result = await markTaskRunning(
      { tasks: taskRepo, dispatchAttempts: attemptRepo },
      { taskId: "task-1", workflowId: "workflow-1" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
      expect(result.message).toContain("stale dispatch attempt");
    }
  });

  it("should reject when attempt state not eligible", async () => {
    const taskRepo: TaskRepository = {
      getById: vi.fn().mockResolvedValue(makeTask()),
      transition: vi.fn(),
    } as any;

    const attemptRepo: DispatchAttemptRepository = {
      getByWorkflowId: vi.fn().mockResolvedValue(makeDispatchAttempt({ state: "completed" })),
      listNonTerminalByMissionTaskId: vi.fn().mockResolvedValue([makeDispatchAttempt({ state: "completed" })]),
      authorizeStart: vi.fn().mockResolvedValue({ ok: false, reason: "attempt_not_eligible", message: `dispatch attempt is not eligible to start (state: completed)` }),
    } as any;

    const result = await markTaskRunning(
      { tasks: taskRepo, dispatchAttempts: attemptRepo },
      { taskId: "task-1", workflowId: "workflow-1" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
      expect(result.message).toContain("dispatch attempt is not eligible to start");
    }
  });
});