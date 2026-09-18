import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DigitalOSTaskExecutionDispatcher } from "./digitalos-task-execution-dispatcher";
import { TemporalTaskExecutionDispatcher } from "./temporal-task-execution-dispatcher";
import { CompositeTaskExecutionDispatcher } from "./composite-task-execution-dispatcher";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryDurableMemory } from "@/core/context/durable-memory";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";
import type { Task, TaskStatus } from "@/core/contracts";
import type { TaskExecutionDispatcher } from "./ports";
import type { DurableMemory } from "@/core/context/durable-memory";

// Mock the saveMissionCheckpoint to avoid needing a durableMemory in tests
vi.mock("@/server/usecases/save-mission-checkpoint", () => ({
  saveMissionCheckpoint: vi.fn().mockResolvedValue({ ok: true, checkpointId: "test-checkpoint" }),
}));

// Mock repositories
function createMockMissionRepo() {
  const missions = new Map<
    string,
    {
      id: string;
      tasks: Array<{ id: string; workerKind: string; capability: string }>;
      createdAt: Date;
      updatedAt: Date;
    }
  >();
  return {
    findById: vi.fn(async (id: string) => missions.get(id)),
    findByTaskId: vi.fn(async (taskId: string) => {
      for (const m of missions.values()) {
        if (m.tasks?.some((t) => t.id === taskId)) return m;
      }
      return null;
    }),
    save: vi.fn(
      async (mission: {
        id: string;
        tasks: Array<{ id: string; workerKind: string; capability: string }>;
        createdAt?: Date;
        updatedAt?: Date;
      }) => {
        const now = new Date();
        const toSave = {
          ...mission,
          createdAt: mission.createdAt ?? now,
          updatedAt: mission.updatedAt ?? now,
        };
        missions.set(mission.id, toSave);
        return toSave;
      },
    ),
    list: vi.fn(async () => Array.from(missions.values())),
    listTasks: vi.fn(async (missionId: string) => missions.get(missionId)?.tasks || []),
    __addMission: (mission: {
      id: string;
      tasks: Array<{ id: string; workerKind: string; capability: string }>;
      createdAt?: Date;
      updatedAt?: Date;
    }) => {
      const now = new Date();
      const toStore = {
        ...mission,
        createdAt: mission.createdAt ?? now,
        updatedAt: mission.updatedAt ?? now,
      };
      missions.set(mission.id, toStore);
    },
    getMissionTaskByCanonicalTaskId: vi.fn(async (taskId: string) => {
      for (const mission of missions.values()) {
        const task = mission.tasks.find((t) => t.id === taskId);
        if (task) {
          return {
            id: task.id,
            missionId: mission.id,
            title: "",
            description: "",
            dependsOn: [],
            status: "draft" as const,
            taskId: task.id,
          };
        }
      }
      return null;
    }),
    updateMissionTaskStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSupervisor() {
  return {
    dispatchNextReadyTask: vi.fn(),
  };
}

function createTestContext() {
  const auditLog = new InMemoryAuditLog();
  const taskStore = new InMemoryTaskRepository(auditLog);
  const executionResults = new InMemoryTaskExecutionResultRepository(auditLog, taskStore);
  const missions = createMockMissionRepo();
  const supervisor = createMockSupervisor();

  return { auditLog, taskStore, executionResults, missions, supervisor };
}

const validStatus: TaskStatus = "queued";

function createSeedTask(id: string, title: string): Task {
  return {
    id,
    title,
    description: "",
    assignedAgentId: undefined,
    status: validStatus,
    actionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Failing TemporalDispatcher for testing fail-closed behavior
function createFailingTemporalDispatcher(): TaskExecutionDispatcher {
  return {
    async dispatch() {
      throw new Error("Temporal unavailable - fail closed");
    },
  };
}

describe("DigitalOSTaskExecutionDispatcher", () => {
  let executionResults: InMemoryTaskExecutionResultRepository;
  let missions: ReturnType<typeof createMockMissionRepo>;
  let supervisor: ReturnType<typeof createMockSupervisor>;
  let dispatcher: DigitalOSTaskExecutionDispatcher;
  let taskStore: InMemoryTaskRepository;

  beforeEach(() => {
    const ctx = createTestContext();
    executionResults = ctx.executionResults;
    missions = ctx.missions;
    supervisor = ctx.supervisor;
    taskStore = ctx.taskStore;
    dispatcher = new DigitalOSTaskExecutionDispatcher(
      executionResults,
      missions as unknown as MissionRepository,
      taskStore as unknown as TaskRepository,
      supervisor as unknown as SupervisorService,
      {} as DurableMemory, // mock durableMemory
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("routes digitalos capability to DigitalOSWorker", async () => {
    const mission = {
      id: "mission-1",
      tasks: [{ id: "task-build-1", workerKind: "digitalos", capability: "website.build" }],
    };
    missions.__addMission(mission);
    taskStore["tasks"].push(createSeedTask("task-build-1", "Build website"));

    const result = await dispatcher.dispatch(
      {
        taskId: "task-build-1",
        prompt: "Build website",
        workerKind: "digitalos",
        capability: "website.build",
        digitalosFacadePath: undefined,
      },
      undefined,
    );

    expect(result.workflowId).toBeDefined();
    const record = await executionResults.getByWorkflowId("icos-task-task-build-1");
    expect(record).toBeDefined();
  });

  it("uses workflowId for idempotence", async () => {
    const mission = {
      id: "mission-1",
      tasks: [{ id: "task-qa-1", workerKind: "digitalos", capability: "website.qa" }],
    };
    missions.__addMission(mission);
    taskStore["tasks"].push(createSeedTask("task-qa-1", "QA website"));

    const input = {
      taskId: "task-qa-1",
      prompt: "QA website",
      workerKind: "digitalos" as const,
      capability: "website.qa" as const,
      digitalosFacadePath: undefined,
    };

    const result1 = await dispatcher.dispatch(input, undefined);
    const result2 = await dispatcher.dispatch(input, undefined);

    expect(result1.workflowId).toBe(result2.workflowId);
    expect(result1.workflowId).toBe("icos-task-task-qa-1");
  });

  it("records TaskExecutionResult with digitalosExecutionId on success path", async () => {
    const mission = {
      id: "mission-1",
      tasks: [{ id: "task-build-2", workerKind: "digitalos", capability: "website.build" }],
    };
    missions.__addMission(mission);
    taskStore["tasks"].push(createSeedTask("task-build-2", "Build website"));

    await dispatcher.dispatch(
      {
        taskId: "task-build-2",
        prompt: "Build website",
        workerKind: "digitalos",
        capability: "website.build",
        digitalosFacadePath: undefined,
      },
      undefined,
    );

    const record = await executionResults.getByWorkflowId("icos-task-task-build-2");
    expect(record).toBeDefined();
    expect(record?.workerKind).toBe("digitalos");
  });
});

describe("CompositeTaskExecutionDispatcher", () => {
  let executionResults: InMemoryTaskExecutionResultRepository;
  let missions: ReturnType<typeof createMockMissionRepo>;
  let supervisor: ReturnType<typeof createMockSupervisor>;
  let taskStore: InMemoryTaskRepository;

  beforeEach(() => {
    const ctx = createTestContext();
    executionResults = ctx.executionResults;
    missions = ctx.missions;
    supervisor = ctx.supervisor;
    taskStore = ctx.taskStore;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  function createDispatcher(options?: {
    temporalDispatcher?: TaskExecutionDispatcher;
    durableMemory?: DurableMemory;
  }): CompositeTaskExecutionDispatcher {
    return new CompositeTaskExecutionDispatcher(
      executionResults,
      missions as unknown as MissionRepository,
      taskStore as unknown as TaskRepository,
      supervisor as unknown as SupervisorService,
      options?.durableMemory ?? new InMemoryDurableMemory(),
      options?.temporalDispatcher ?? new TemporalTaskExecutionDispatcher(),
    );
  }

  describe("Routing rules", () => {
    it("routes workerKind=digitalos to DigitalOS path", async () => {
      const mission = {
        id: "mission-1",
        tasks: [{ id: "task-build-3", workerKind: "digitalos", capability: "website.build" }],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-build-3", "Build website"));

      const dispatcher = createDispatcher();
      const result = await dispatcher.dispatch({
        taskId: "task-build-3",
        prompt: "Build website",
        workerKind: "digitalos",
        capability: "website.build",
      });

      expect(result.workflowId).toBe("icos-task-task-build-3");
    });

    it("routes capability=website.* to DigitalOS path regardless of workerKind", async () => {
      const mission = {
        id: "mission-1",
        tasks: [{ id: "task-qa-2", workerKind: "hermes", capability: "website.qa" }],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-qa-2", "QA website"));

      const dispatcher = createDispatcher();
      const result = await dispatcher.dispatch({
        taskId: "task-qa-2",
        prompt: "QA website",
        workerKind: "hermes",
        capability: "website.qa",
      });

      expect(result.workflowId).toBe("icos-task-task-qa-2");
    });

    it("routes workerKind=hermes to Temporal path (uses default temporal)", async () => {
      const mission = {
        id: "mission-1",
        tasks: [{ id: "task-hermes-routing-1", workerKind: "hermes", capability: "code.generate" }],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-hermes-routing-1", "Generate code"));

      // Use a mock temporal dispatcher to verify routing without connecting to Temporal
      const mockTemporalDispatcher: TaskExecutionDispatcher = {
        async dispatch(input) {
          return { workflowId: `icos-task-${input.taskId}` };
        },
      };
      const dispatcher = createDispatcher({ temporalDispatcher: mockTemporalDispatcher });

      // Just verify it routes to temporal (workflowId format indicates temporal path)
      const result = await dispatcher.dispatch({
        taskId: "task-hermes-routing-1",
        prompt: "Generate code",
        workerKind: "hermes",
        capability: "code.generate",
      });

      expect(result.workflowId).toBeDefined();
      // Temporal path produces icos-task-* workflow IDs
      expect(result.workflowId.startsWith("icos-task-")).toBe(true);
    });

    it("routes workerKind=openhands to Temporal path (uses default temporal)", async () => {
      const mission = {
        id: "mission-1",
        tasks: [
          { id: "task-openhands-routing-1", workerKind: "openhands", capability: "code.review" },
        ],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-openhands-routing-1", "Review code"));

      // Use a mock temporal dispatcher to verify routing without connecting to Temporal
      const mockTemporalDispatcher: TaskExecutionDispatcher = {
        async dispatch(input) {
          return { workflowId: `icos-task-${input.taskId}` };
        },
      };
      const dispatcher = createDispatcher({ temporalDispatcher: mockTemporalDispatcher });
      const result = await dispatcher.dispatch({
        taskId: "task-openhands-routing-1",
        prompt: "Review code",
        workerKind: "openhands",
        capability: "code.review",
      });

      expect(result.workflowId).toBeDefined();
      expect(result.workflowId.startsWith("icos-task-")).toBe(true);
    });

    it("routes unknown workerKind to local path", async () => {
      const mission = {
        id: "mission-1",
        tasks: [{ id: "task-unknown-1", workerKind: "unknown", capability: "unknown.thing" }],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-unknown-1", "Unknown task"));

      const dispatcher = createDispatcher();
      const result = await dispatcher.dispatch({
        taskId: "task-unknown-1",
        prompt: "Unknown task",
        workerKind: "unknown",
        capability: "unknown.thing",
      });

      expect(result.workflowId).toBeDefined();
      expect(result.workflowId.startsWith("icos-local-")).toBe(true);
    });

    it("PRODUCTION behavior: Temporal unavailable fails closed (no InMemory fallback)", async () => {
      // This test verifies the critical production behavior:
      // When Temporal is unavailable for hermes/openhands, it MUST fail, not fall back to InMemory
      const mission = {
        id: "mission-prod",
        tasks: [{ id: "task-prod-1", workerKind: "hermes", capability: "code.generate" }],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-prod-1", "Generate code"));

      // Inject a FAILING temporal dispatcher to simulate production Temporal unavailability
      const dispatcher = createDispatcher({
        temporalDispatcher: createFailingTemporalDispatcher(),
      });

      // In production composition, TemporalDispatcher is used directly without fallback
      // This should throw (fail closed) rather than silently using InMemory
      await expect(
        dispatcher.dispatch({
          taskId: "task-prod-1",
          prompt: "Generate code",
          workerKind: "hermes",
          capability: "code.generate",
        }),
      ).rejects.toThrow("Temporal unavailable - fail closed");
    });

    it("PRODUCTION behavior: openhands Temporal unavailable fails closed", async () => {
      const mission = {
        id: "mission-prod",
        tasks: [{ id: "task-prod-2", workerKind: "openhands", capability: "code.review" }],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-prod-2", "Review code"));

      const dispatcher = createDispatcher({
        temporalDispatcher: createFailingTemporalDispatcher(),
      });

      await expect(
        dispatcher.dispatch({
          taskId: "task-prod-2",
          prompt: "Review code",
          workerKind: "openhands",
          capability: "code.review",
        }),
      ).rejects.toThrow("Temporal unavailable - fail closed");
    });
  });

  describe("Idempotence", () => {
    it("returns same workflowId for duplicate dispatches (digitalos)", async () => {
      const mission = {
        id: "mission-1",
        tasks: [{ id: "task-heal-1", workerKind: "digitalos", capability: "website.heal" }],
      };
      missions.__addMission(mission);
      taskStore["tasks"].push(createSeedTask("task-heal-1", "Heal website"));

      const input = {
        taskId: "task-heal-1",
        prompt: "Heal website",
        workerKind: "digitalos" as const,
        capability: "website.heal" as const,
      };

      const dispatcher = createDispatcher();
      const result1 = await dispatcher.dispatch(input);
      const result2 = await dispatcher.dispatch(input);

      expect(result1.workflowId).toBe(result2.workflowId);
      expect(result1.workflowId).toBe("icos-task-task-heal-1");
    });
  });
});
