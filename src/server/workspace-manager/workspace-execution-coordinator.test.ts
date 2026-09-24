import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Git } from "./git";
import type { WorkspaceManager } from "./manager";
import type { IntegrationGate } from "./integration-gate";
import type { IntegrationReport } from "./report";
import type { Workspace } from "./types";
import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "@/server/execution/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { DurableMemory } from "@/core/context/durable-memory";
import { WorkspaceExecutionCoordinator } from "./workspace-execution-coordinator";

// Test utilities
function createMockGit(): Git {
  return {
    statusPorcelain: vi.fn().mockResolvedValue([]),
    headCommit: vi.fn().mockResolvedValue("abc123"),
    resolveCommit: vi.fn().mockResolvedValue("target-commit"),
    changedFiles: vi.fn().mockResolvedValue([]),
    addedLines: vi.fn().mockResolvedValue([]),
    diffCheck: vi.fn().mockResolvedValue({ ok: true, output: "" }),
    isAncestor: vi.fn().mockResolvedValue(true),
    branchExists: vi.fn().mockResolvedValue(false),
    mergeConflicts: vi.fn().mockResolvedValue([]),
    listDir: vi.fn().mockResolvedValue([]),
    worktrees: vi.fn().mockResolvedValue([]),
    commitExists: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    deleteBranchIfMerged: vi.fn().mockResolvedValue(false),
  } as unknown as Git;
}

function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    workspaceId: "ws-test-123",
    slug: "task-test",
    workerId: "worker-1",
    missionId: "mission-1",
    taskId: "task-1",
    status: "ready",
    branch: "ws/task-test",
    worktreePath: "/tmp/ws/task-test",
    baseCommit: "base-commit",
    integrationTarget: "integration/phase-7",
    testDatabase: "test_db",
    fileScope: { owns: [], shared: [], forbidden: [] },
    migrationReservation: null,
    leaseOwner: "coordinator",
    leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    fencingToken: 1,
    workflowId: "icos-mission-1-task-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    releasedAt: null,
    sourceCommit: null,
    ...overrides,
  };
}

function createMockManager(): WorkspaceManager & { _workspaces: Map<string, Workspace> } {
  const workspaces = new Map<string, Workspace>();

  const manager = {
    _workspaces: workspaces,
    list: vi.fn().mockImplementation(async () => Array.from(workspaces.values())),
    get: vi.fn().mockImplementation(async (id: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      return ws;
    }),
    request: vi.fn().mockImplementation(async (input) => {
      const ws = createMockWorkspace({
        workspaceId: `ws-${randomUUID()}`,
        slug: input.slug,
        workerId: input.workerId,
        missionId: input.missionId ?? "mission-1",
        taskId: input.taskId ?? "task-1",
        workflowId: input.workflowId ?? "icos-mission-1-task-1",
      });
      workspaces.set(ws.workspaceId, ws);
      return ws;
    }),
    create: vi.fn().mockImplementation(async (id: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      return { ...ws, status: "ready" };
    }),
    transition: vi.fn().mockImplementation(async (id: string, status: Workspace["status"]) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      ws.status = status;
      ws.updatedAt = new Date().toISOString();
      return ws;
    }),
    acquireLease: vi.fn().mockImplementation(async (id: string, owner: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      ws.leaseOwner = owner;
      ws.leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      ws.fencingToken = (ws.fencingToken ?? 0) + 1;
      return ws;
    }),
    renewLease: vi.fn().mockImplementation(async (id: string, owner: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      ws.leaseOwner = owner;
      ws.leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      return ws;
    }),
    releaseLease: vi.fn().mockImplementation(async (id: string, owner: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      ws.leaseOwner = null;
      ws.leaseExpiresAt = null;
      return ws;
    }),
    recordSourceCommit: vi.fn().mockImplementation(async (id: string, commit: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      ws.sourceCommit = commit;
      return ws;
    }),
    cleanup: vi.fn().mockImplementation(async (id: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`NOT_FOUND: workspace ${id}`);
      ws.releasedAt = new Date().toISOString();
      return {
        worktreeRemoved: true,
        branchDeleted: true,
        databaseDropped: true,
        archivePath: "/tmp/archive.json",
      };
    }),
  } as unknown as WorkspaceManager & { _workspaces: Map<string, Workspace> };

  return manager;
}

function createMockIntegrationGate(): IntegrationGate {
  return {
    integrate: vi
      .fn()
      .mockImplementation(async (workspaceId: string, options?: { humanApprovedBy?: string }) => {
        const report: IntegrationReport = {
          workspaceId,
          workerId: "worker-1",
          branch: "ws/task-test",
          worktree: "/tmp/ws/task-test",
          baseCommit: "base-commit",
          targetCommit: "target-commit",
          testDatabase: "test_db",
          fileScopeStatus: "PASS",
          sharedFilesChanged: [],
          migrations: [],
          typecheck: "PASS",
          lint: "PASS",
          unitTests: "PASS",
          postgresTests: "PASS",
          build: "PASS",
          secretCheck: "PASS",
          conflictStatus: "CLEAN",
          conflictFiles: [],
          decision: options?.humanApprovedBy ? "ACCEPT" : "NEEDS_HUMAN_APPROVAL",
          commitSha: "abc123",
          reasons: options?.humanApprovedBy
            ? [`approuvé par ${options.humanApprovedBy}`]
            : ["revue absente"],
        };
        return report;
      }),
  } as unknown as IntegrationGate;
}

function createMockDispatcher(): TaskExecutionDispatcher {
  return {
    dispatch: vi
      .fn()
      .mockImplementation(
        async (input: TaskExecutionDispatchInput): Promise<TaskExecutionDispatchResult> => {
          return { workflowId: input.workflowId ?? `icos-task-${input.taskId}` };
        },
      ),
  } as unknown as TaskExecutionDispatcher;
}

function createMockMissions(): MissionRepository {
  return {
    findById: vi.fn().mockResolvedValue({ id: "mission-1", status: "running" }),
    listTasks: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([{ id: "mission-1" }]),
    applyPlan: vi.fn().mockResolvedValue(undefined),
    replacePlan: vi.fn().mockResolvedValue(undefined),
    updateMissionStatus: vi.fn().mockResolvedValue(undefined),
    updateMissionTaskStatus: vi.fn().mockResolvedValue(undefined),
    getMissionTaskById: vi
      .fn()
      .mockResolvedValue({ id: "task-1", taskId: "task-1", title: "Test Task" }),
  } as unknown as MissionRepository;
}

function createMockTasks(): TaskRepository {
  return {} as unknown as TaskRepository;
}

function createMockDurableMemory(): DurableMemory {
  return {
    saveHandoffPackage: vi.fn().mockResolvedValue(undefined),
    loadHandoffPackage: vi.fn().mockResolvedValue(null),
  } as unknown as DurableMemory;
}

function randomUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

describe("WorkspaceExecutionCoordinator (Phase 8D)", () => {
  let coordinator: WorkspaceExecutionCoordinator;
  let mockGit: Git;
  let mockManager: WorkspaceManager;
  let mockIntegrationGate: IntegrationGate;
  let mockDispatcher: TaskExecutionDispatcher;
  let mockMissions: MissionRepository;
  let mockTasks: TaskRepository;
  let mockDurableMemory: DurableMemory;

  beforeEach(() => {
    mockGit = createMockGit();
    mockManager = createMockManager();
    mockIntegrationGate = createMockIntegrationGate();
    mockDispatcher = createMockDispatcher();
    mockMissions = createMockMissions();
    mockTasks = createMockTasks();
    mockDurableMemory = createMockDurableMemory();

    coordinator = new WorkspaceExecutionCoordinator({
      git: mockGit,
      manager: mockManager,
      integrationGate: mockIntegrationGate,
      dispatcher: mockDispatcher,
      missions: mockMissions,
      tasks: mockTasks,
      durableMemory: mockDurableMemory,
      leaseMs: 5 * 60 * 1000,
      leaseRenewalIntervalMs: 60 * 1000,
      ownerToken: "coordinator",
    });
  });

  afterEach(async () => {
    await coordinator.shutdown();
  });

  describe("idempotent workspace allocation", () => {
    it("allocates a new workspace for a task", async () => {
      const execWs = await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      expect(execWs).toBeDefined();
      expect(execWs.workspaceId).toContain("ws-");
      expect(execWs.taskId).toBe("task-1");
      expect(execWs.missionId).toBe("mission-1");
      expect(execWs.status).toBe("allocated");
    });

    it("returns existing workspace on second allocation (idempotent)", async () => {
      const first = await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");
      const second = await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      expect(first.workspaceId).toBe(second.workspaceId);
    });

    it("tracks execution workspace in internal map", async () => {
      const execWs = await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");
      const tracked = coordinator.getExecutionWorkspace("task-1");

      expect(tracked).toBeDefined();
      expect(tracked?.workspaceId).toBe(execWs.workspaceId);
    });

    it("rejects a different canonical workflow for an already allocated task", async () => {
      await coordinator.allocateWorkspace(
        "mission-1",
        "task-1",
        "worker-1",
        undefined,
        "workflow-a",
      );

      await expect(
        coordinator.allocateWorkspace("mission-1", "task-1", "worker-1", undefined, "workflow-b"),
      ).rejects.toThrow(/WORKFLOW_COLLISION/);
    });
  });

  describe("workspace-aware dispatcher bridge", () => {
    it("executes task in allocated workspace via dispatcher", async () => {
      await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      const result = await coordinator.executeInWorkspace("mission-1", "task-1", {
        taskId: "task-1",
        prompt: "Test prompt",
        workerKind: "digitalos",
        capability: "test-capability",
      });

      expect(result.success).toBeDefined();
      expect(result.workspaceId).toBeDefined();
      expect(result.taskId).toBe("task-1");
      expect(mockDispatcher.dispatch).toHaveBeenCalled();
    });

    it("passes workflowId through to dispatcher for idempotency", async () => {
      await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      const customWorkflowId = "custom-workflow-123";
      await coordinator.executeInWorkspace("mission-1", "task-1", {
        taskId: "task-1",
        prompt: "Test prompt",
        workerKind: "digitalos",
        capability: "test-capability",
        workflowId: customWorkflowId,
      });

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: customWorkflowId }),
      );
    });

    it("verifies workflowId matches after dispatch (idempotency check)", async () => {
      const mismatchedDispatcher = {
        dispatch: vi.fn().mockResolvedValue({ workflowId: "different-workflow-id" }),
      } as unknown as TaskExecutionDispatcher;

      const mismatchedCoordinator = new WorkspaceExecutionCoordinator({
        git: mockGit,
        manager: mockManager,
        integrationGate: mockIntegrationGate,
        dispatcher: mismatchedDispatcher,
        missions: mockMissions,
        tasks: mockTasks,
        durableMemory: mockDurableMemory,
      });

      await mismatchedCoordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      await expect(
        mismatchedCoordinator.executeInWorkspace("mission-1", "task-1", {
          taskId: "task-1",
          prompt: "Test prompt",
          workerKind: "digitalos",
          capability: "test-capability",
          workflowId: "expected-workflow-id",
        }),
      ).rejects.toThrow("DISPATCH_WORKFLOW_ID_MISMATCH");

      await mismatchedCoordinator.shutdown();
    });

    it("transitions workspace through correct states: allocated -> executing -> validating -> completed", async () => {
      const ws = await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      expect(ws.status).toBe("allocated");

      await coordinator.executeInWorkspace(
        "mission-1",
        "task-1",
        {
          taskId: "task-1",
          prompt: "Test prompt",
          workerKind: "digitalos",
          capability: "test-capability",
        },
        "human-reviewer",
      );

      const tracked = coordinator.getExecutionWorkspace("task-1");
      expect(tracked?.status).toBe("completed");

      // Verify manager.transition was called with correct sequence
      const transitions = (mockManager.transition as ReturnType<typeof vi.fn>).mock.calls;
      const statuses = transitions.map((call) => call[1]);
      expect(statuses).toContain("working");
      expect(statuses).toContain("validating");
      expect(statuses).toContain("ready_for_integration");
    });
  });

  describe("QC ACCEPT -> IntegrationGate handoff", () => {
    it("runs IntegrationGate after successful execution", async () => {
      await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      await coordinator.executeInWorkspace(
        "mission-1",
        "task-1",
        {
          taskId: "task-1",
          prompt: "Test prompt",
          workerKind: "digitalos",
          capability: "test-capability",
        },
        "human-reviewer",
      );

      expect(mockIntegrationGate.integrate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          humanApprovedBy: "human-reviewer",
          lease: { owner: "coordinator", fencingToken: 1 },
        }),
      );
    });

    it("returns NEEDS_HUMAN_APPROVAL when no human approval provided", async () => {
      await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      const result = await coordinator.executeInWorkspace("mission-1", "task-1", {
        taskId: "task-1",
        prompt: "Test prompt",
        workerKind: "digitalos",
        capability: "test-capability",
      });

      expect(result.decision).toBe("NEEDS_HUMAN_APPROVAL");
      expect(result.success).toBe(false);
    });

    it("returns ACCEPT when human approval provided", async () => {
      await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      const result = await coordinator.executeInWorkspace(
        "mission-1",
        "task-1",
        {
          taskId: "task-1",
          prompt: "Test prompt",
          workerKind: "digitalos",
          capability: "test-capability",
        },
        "human-reviewer",
      );

      expect(result.decision).toBe("ACCEPT");
      expect(result.success).toBe(true);
    });
  });

  describe("release workspace", () => {
    it("releases workspace and cleans up resources", async () => {
      const execWs = await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");
      await coordinator.executeInWorkspace(
        "mission-1",
        "task-1",
        {
          taskId: "task-1",
          prompt: "Test prompt",
          workerKind: "digitalos",
          capability: "test-capability",
        },
        "human-reviewer",
      );

      await coordinator.releaseWorkspace("task-1");

      expect(mockManager.cleanup).toHaveBeenCalledWith(
        execWs.workspaceId,
        "coordinator",
        execWs.fencingToken,
      );
      const tracked = coordinator.getExecutionWorkspace("task-1");
      expect(tracked?.status).toBe("released");
      expect(tracked?.releasedAt).toBeDefined();
    });

    it("is idempotent - safe to call multiple times", async () => {
      await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      await coordinator.releaseWorkspace("task-1");
      await coordinator.releaseWorkspace("task-1"); // Should not throw

      expect(mockManager.cleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe("restart reconciliation", () => {
    it("recovers workspaces with valid leases", async () => {
      const ws = createMockWorkspace({
        workspaceId: "ws-recover-1",
        missionId: "mission-1",
        taskId: "task-recover-1",
        status: "working",
        leaseOwner: "coordinator",
        leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      // Add to mock manager's internal map
      (mockManager as unknown as { _workspaces?: Map<string, Workspace> })._workspaces?.set(
        ws.workspaceId,
        ws,
      );
      (mockManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([ws]);

      const result = await coordinator.reconcile("mission-1");

      expect(result.recovered).toBe(1);
      expect(result.released).toBe(0);
    });

    it("releases workspaces with expired leases and no committed work", async () => {
      const ws = createMockWorkspace({
        workspaceId: "ws-recover-2",
        missionId: "mission-1",
        taskId: "task-recover-2",
        status: "working",
        leaseOwner: "coordinator",
        leaseExpiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // Expired
      });

      (mockManager as unknown as { _workspaces?: Map<string, Workspace> })._workspaces?.set(
        ws.workspaceId,
        ws,
      );
      (mockManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([ws]);
      (mockGit.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await coordinator.reconcile("mission-1");

      expect(result.released).toBe(1);
    });

    it("recovers workspaces with expired leases but committed work", async () => {
      const ws = createMockWorkspace({
        workspaceId: "ws-recover-3",
        missionId: "mission-1",
        taskId: "task-recover-3",
        status: "working",
        leaseOwner: "coordinator",
        leaseExpiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      });

      (mockManager as unknown as { _workspaces?: Map<string, Workspace> })._workspaces?.set(
        ws.workspaceId,
        ws,
      );
      (mockManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([ws]);
      (mockGit.changedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "src/file.ts", status: "modified" },
      ]);

      const result = await coordinator.reconcile("mission-1");

      expect(result.recovered).toBe(1);
    });

    it("blocks workspaces with uncommitted changes", async () => {
      const ws = createMockWorkspace({
        workspaceId: "ws-recover-4",
        missionId: "mission-1",
        taskId: "task-recover-4",
        status: "working",
        leaseOwner: "coordinator",
        leaseExpiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      });

      (mockManager as unknown as { _workspaces?: Map<string, Workspace> })._workspaces?.set(
        ws.workspaceId,
        ws,
      );
      (mockManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([ws]);
      (mockGit.statusPorcelain as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "src/file.ts", status: "modified" },
      ]);

      const result = await coordinator.reconcile("mission-1");

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("uncommitted changes");
    });
  });

  describe("fail-closed error handling", () => {
    it("stops dispatch and IntegrationGate after renewal failure", async () => {
      const dispatch = mockDispatcher.dispatch as ReturnType<typeof vi.fn>;
      await coordinator.allocateWorkspace(
        "mission-1",
        "task-lease-loss",
        "worker-1",
        undefined,
        "workflow-lease-loss",
      );
      coordinator["ownershipLost"].add(
        coordinator.getExecutionWorkspace("task-lease-loss")!.workspaceId,
      );
      await expect(
        coordinator.executeInWorkspace("mission-1", "task-lease-loss", {
          taskId: "task-lease-loss",
          prompt: "must not execute",
          workerKind: "digitalos",
          capability: "test-capability",
          workflowId: "workflow-lease-loss",
        }),
      ).rejects.toThrow("OWNERSHIP_LOST");
      expect(dispatch).not.toHaveBeenCalled();
      expect(mockIntegrationGate.integrate).not.toHaveBeenCalled();
    });

    it("does not run IntegrationGate when ownership is lost after dispatch", async () => {
      (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (input) => {
          const workspace = Array.from(
            (
              mockManager as WorkspaceManager & { _workspaces: Map<string, Workspace> }
            )._workspaces.values(),
          )[0]!;
          workspace.leaseOwner = "replacement-owner";
          workspace.fencingToken += 1;
          return { workflowId: input.workflowId };
        },
      );

      await coordinator.allocateWorkspace(
        "mission-1",
        "task-gate-loss",
        "worker-1",
        undefined,
        "workflow-gate-loss",
      );
      const result = await coordinator.executeInWorkspace("mission-1", "task-gate-loss", {
        taskId: "task-gate-loss",
        prompt: "lose lease after dispatch",
        workerKind: "digitalos",
        capability: "test-capability",
        workflowId: "workflow-gate-loss",
      });

      expect(result.error).toContain("OWNERSHIP_LOST");
      expect(mockIntegrationGate.integrate).not.toHaveBeenCalled();
    });

    it("handles dispatcher failure gracefully", async () => {
      const failingDispatcher = {
        dispatch: vi.fn().mockRejectedValue(new Error("Dispatcher unavailable")),
      } as unknown as TaskExecutionDispatcher;

      const failingCoordinator = new WorkspaceExecutionCoordinator({
        git: mockGit,
        manager: mockManager,
        integrationGate: mockIntegrationGate,
        dispatcher: failingDispatcher,
        missions: mockMissions,
        tasks: mockTasks,
        durableMemory: mockDurableMemory,
      });

      await failingCoordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      const result = await failingCoordinator.executeInWorkspace("mission-1", "task-1", {
        taskId: "task-1",
        prompt: "Test prompt",
        workerKind: "digitalos",
        capability: "test-capability",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Dispatcher unavailable");

      await failingCoordinator.shutdown();
    });

    it("handles IntegrationGate failure gracefully", async () => {
      const failingGate = {
        integrate: vi.fn().mockRejectedValue(new Error("Gate failed")),
      } as unknown as IntegrationGate;

      const failingCoordinator = new WorkspaceExecutionCoordinator({
        git: mockGit,
        manager: mockManager,
        integrationGate: failingGate,
        dispatcher: mockDispatcher,
        missions: mockMissions,
        tasks: mockTasks,
        durableMemory: mockDurableMemory,
      });

      await failingCoordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      const result = await failingCoordinator.executeInWorkspace("mission-1", "task-1", {
        taskId: "task-1",
        prompt: "Test prompt",
        workerKind: "digitalos",
        capability: "test-capability",
      });

      expect(result.success).toBe(false);

      await failingCoordinator.shutdown();
    });
  });

  describe("lease renewal coordination", () => {
    it("starts lease renewal timer on allocation", async () => {
      await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");

      expect(mockManager.renewLease).toHaveBeenCalled();
    });

    it("stops lease renewal on release", async () => {
      const execWs = await coordinator.allocateWorkspace("mission-1", "task-1", "worker-1");
      await coordinator.releaseWorkspace("task-1");

      // Verify lease was released with fencing token
      expect(mockManager.cleanup).toHaveBeenCalledWith(
        execWs.workspaceId,
        "coordinator",
        execWs.fencingToken,
      );
    });
  });
});
