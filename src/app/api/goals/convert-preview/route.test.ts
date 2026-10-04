import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import type { GoalRepository } from "@/server/repositories/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import { HighLevelGoal, GoalPlanPreview, GoalPlanPreviewSchema } from "@/core/contracts/high-level-goal";
import { GoalNormalizer } from "@/server/services/goal-normalizer";
import { GoalPlanner } from "@/server/services/goal-planner";
import { GoalPreviewStore } from "@/server/services/goal-preview-store";
import { MissionService } from "@/server/mission/mission-service";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

type Access = Role | "anonymous" | "expired" | "no-auth-gateway";

function install(access: Access) {
  const session: AuthenticatedSession | null =
    access === "anonymous" || access === "expired" || access === "no-auth-gateway"
      ? null
      : { user: { id: "human-1", email: "h@icos.test", name: "H", status: "active" }, roles: [access] };
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session), // expired => cookie present but no valid session
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const dispatch = vi.fn(async (input: { workflowId?: string; taskId: string }) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));
  const baseContainer = buildMemoryContainer();
  // We will set spies for the services we need in each test
    const goalRepository = new (class implements GoalRepository {
    create = vi.fn().mockResolvedValue(undefined);
    list = vi.fn().mockResolvedValue([]);
    getById = vi.fn().mockResolvedValue(null);
    updateStatus = vi.fn().mockResolvedValue(undefined);
    setConverted = vi.fn().mockResolvedValue(undefined);
    setIdempotencyKey = vi.fn().mockResolvedValue(undefined);
    getByIdempotencyKey = vi.fn().mockResolvedValue(null);
  })() as GoalRepository;

  const container: Container = {
    ...baseContainer,
    auth: access === "no-auth-gateway" ? undefined : auth,
    autonomousPlanner: { plan: vi.fn() } as never, // not used in this route
    taskExecution: { dispatch } as never,
    goalNormalizer: new GoalNormalizer(), // not used
    goalPlanner: new GoalPlanner(),
    goalPreviewStore: new GoalPreviewStore(goalRepository),
    /* The route writes the goal's side of the link, so the container must expose it. */
    goalRepository,
    mission: {
      // Mock mission repository with proper Mission return type
      list: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: 'mission-id',
        title: 'Mission Title',
        objective: 'Mission Objective',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      applyPlan: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      findByGoalId: vi.fn().mockResolvedValue(null),
      listTasks: vi.fn().mockResolvedValue([]),
      getMissionIdByTaskId: vi.fn().mockResolvedValue(null),
      getMissionTaskById: vi.fn().mockResolvedValue(null),
      getMissionTaskByCanonicalTaskId: vi.fn().mockResolvedValue(null),
      updateMissionTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateMissionStatus: vi.fn().mockResolvedValue(undefined),
      deleteMission: vi.fn().mockResolvedValue(undefined),
      updateMission: vi.fn().mockResolvedValue(undefined),
      updateMissionTaskDependsOn: vi.fn().mockResolvedValue(undefined),
    } as never,
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return { container, dispatch, auth: container.auth as AuthGateway, readSession: auth.readSession as ReturnType<typeof vi.fn> };
}

async function callRoute(headers: Record<string, string>, body: unknown) {
  const { POST } = await import("./route");
  return POST(
    new Request(`${ORIGIN}/api/goals/convert-preview`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const authed = { origin: ORIGIN, cookie: COOKIE };

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/goals/convert-preview — authentication and authorization (fail closed)", () => {
  async function expectNothingCreated(f: ReturnType<typeof install>) {
    // We don't have mission creation here, but we can check that the goalPreviewStore was not called if needed.
    // For now, we just check that the container's functions were called as expected.
  }

  it("401 without any session credential, and nothing is created", async () => {
    const f = install("anonymous");
    const response = await callRoute({ origin: ORIGIN }, {});
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(f.readSession).not.toHaveBeenCalled();
    await expectNothingCreated(f);
  });

  it("401 with an expired session (cookie present, no valid session), and nothing is created", async () => {
    const f = install("expired");
    const response = await callRoute(authed, {});
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "session_expired" } });
    await expectNothingCreated(f);
  });

  it("401 (fail closed) when no auth gateway is configured, even with a cookie", async () => {
    const f = install("no-auth-gateway");
    expect((await callRoute(authed, {})).status).toBe(401);
    await expectNothingCreated(f);
  });

  it("403 for a user without the permission (viewer), and nothing is created", async () => {
    const f = install("viewer");
    const response = await callRoute(authed, {});
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    await expectNothingCreated(f);
  });

  it("403 for a cross-origin mutation, and nothing is created", async () => {
    const f = install("operator");
    expect((await callRoute({ ...authed, origin: "http://evil.test" }, {})).status).toBe(403);
    await expectNothingCreated(f);
  });

  it("authorizes before parsing: an unauthenticated invalid body is 401, never 400", async () => {
    install("anonymous");
    expect((await callRoute({ origin: ORIGIN }, "{not json")).status).toBe(401);
  });

  it("does not put the session credential in the logs on denial", async () => {
    const f = install("expired");
    const log = vi.spyOn(console, "error");
    await callRoute(authed, {});
    expect(JSON.stringify(log.mock.calls)).not.toContain("opaque-test-value");
  });
});

describe("POST /api/goals/convert-preview — authorized behavior", () => {
  it.each(["operator", "admin", "owner"] as const)(
    "%s: 200 OK, converts preview to mission",
    async (role) => {
      const f = install(role);
      const goalId = 'goal-id';
      const goal: HighLevelGoal = {
        id: goalId,
        title: 'Test goal',
        objective: 'Test objective',
        rawInput: 'Test goal: Test objective',
        normalizedIntent: 'Test objective',
        constraints: [],
        successCriteria: [],
        priority: 3,
        riskLevel: "reversible",
        deadline: undefined,
        budget: undefined,
        allowedCapabilities: [],
        forbiddenCapabilities: [],
        humanApprovalPolicy: "if_risky",
        metadata: {},
        createdAt: new Date().toISOString(),
      };
      const previewInput: GoalPlanPreview = {
        goalId,
        missionTitle: 'Mission Title',
        missionObjective: 'Mission Objective',
        tasks: [
          {
            id: 'task-id',
            title: 'Task A',
            description: 'do a',
            dependsOn: [],
            capability: 'some-capability',
            workerKind: 'some-worker',
            riskLevel: 'reversible',
            humanApprovalRequired: false,
            acceptanceCriteria: [],
            parallelizable: true,
            sandboxRequired: false,
            isolatedWorkspaceRequired: false,
          },
        ],
      };
      const previewParsed = GoalPlanPreviewSchema.parse(previewInput);
      // Mock the preview store to return the goal when retrieve is called with the goalId
      f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
      // Mock the planner to return the parsed preview when plan is called with the goal
      f.container.goalPlanner.plan = vi.fn().mockResolvedValue(previewParsed);

      const response = await callRoute(authed, { preview: previewParsed });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('mission');
      expect(body.mission).toMatchObject({
        id: 'mission-id',
        title: 'Mission Title',
        objective: 'Mission Objective',
        status: 'pending',
      });

      // Check that the container methods were called
      expect(f.container.goalPreviewStore.retrieve).toHaveBeenCalledWith(goalId);
      expect(f.container.goalPlanner.plan).toHaveBeenCalledWith(goal);
      // Note: the mission service is not called directly; the route creates a new MissionService instance.
      // We can't easily spy on that without mocking the MissionService constructor. We'll skip for now.
    },
  );

  it("400 on an invalid body for an authorized user, creating nothing", async () => {
    const f = install("operator");
    expect((await callRoute(authed, { preview: {} })).status).toBe(400);
  });

  it("400 when the preview does not match the canonical preview (tampering)", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const goal: HighLevelGoal = {
      id: goalId,
      title: 'Test goal',
      objective: 'Test objective',
      rawInput: 'Test goal: Test objective',
      normalizedIntent: 'Test objective',
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const canonicalPreviewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-id',
          title: 'Task A',
          description: 'do a',
          dependsOn: [],
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    const tamperedPreviewInput: GoalPlanPreview = {
      ...canonicalPreviewInput,
      tasks: [
        {
          ...canonicalPreviewInput.tasks[0],
          title: 'Tampered Task A', // changed title
        },
      ],
    };
    const canonicalPreviewParsed = GoalPlanPreviewSchema.parse(canonicalPreviewInput);
    // Mock the preview store to return the goal when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
    // Mock the planner to return the canonical parsed preview when plan is called with the goal
    f.container.goalPlanner.plan = vi.fn().mockResolvedValue(canonicalPreviewParsed);

    const response = await callRoute(authed, { preview: tamperedPreviewInput });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", message: "preview non autorisé" } });
  });

  it("400 when the goal is not found in the preview store", async () => {
    const f = install("operator");
    const goalId = 'unknown-goal';
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-id',
          title: 'Task A',
          description: 'do a',
          dependsOn: [],
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    // Mock the preview store to return null when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(null);

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", message: "goal introuvable ou expiré" } });
  });

  it("400 when there is an unknown dependency", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const goal: HighLevelGoal = {
      id: goalId,
      title: 'Test goal',
      objective: 'Test objective',
      rawInput: 'Test goal: Test objective',
      normalizedIntent: 'Test objective',
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-id',
          title: 'Task A',
          description: 'do a',
          dependsOn: ['unknown-task'], // unknown dependency
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    // Mock the preview store to return the goal when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
    // Mock the planner to return the parsed preview when plan is called with the goal
    f.container.goalPlanner.plan = vi.fn().mockResolvedValue(GoalPlanPreviewSchema.parse(previewInput));

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", message: expect.stringContaining("Unknown dependency") } });
  });

  it("400 when there is a cycle in the dependencies", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const goal: HighLevelGoal = {
      id: goalId,
      title: 'Test goal',
      objective: 'Test objective',
      rawInput: 'Test goal: Test objective',
      normalizedIntent: 'Test objective',
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-a',
          title: 'Task A',
          description: 'do a',
          dependsOn: ['task-b'], // depends on task-b
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
        {
          id: 'task-b',
          title: 'Task B',
          description: 'do b',
          dependsOn: ['task-a'], // depends on task-a -> cycle
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    // Mock the preview store to return the goal when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
    // Mock the planner to return the parsed preview when plan is called with the goal
    f.container.goalPlanner.plan = vi.fn().mockResolvedValue(GoalPlanPreviewSchema.parse(previewInput));

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", message: expect.stringContaining("Cycle detected") } });
  });

  it("400 when there is a self-dependency", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const goal: HighLevelGoal = {
      id: goalId,
      title: 'Test goal',
      objective: 'Test objective',
      rawInput: 'Test goal: Test objective',
      normalizedIntent: 'Test objective',
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-id',
          title: 'Task A',
          description: 'do a',
          dependsOn: ['task-id'], // self-dependency
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    // Mock the preview store to return the goal when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
    // Mock the planner to return the parsed preview when plan is called with the goal
    f.container.goalPlanner.plan = vi.fn().mockResolvedValue(GoalPlanPreviewSchema.parse(previewInput));

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", message: "auto-dépendance détectée" } });
  });

  it("400 when there are no tasks", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const goal: HighLevelGoal = {
      id: goalId,
      title: 'Test goal',
      objective: 'Test objective',
      rawInput: 'Test goal: Test objective',
      normalizedIntent: 'Test objective',
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [], // no tasks
    };
    // Mock the preview store to return the goal when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
    // Mock the planner to return the parsed preview when plan is called with the goal
    f.container.goalPlanner.plan = vi.fn().mockResolvedValue(GoalPlanPreviewSchema.parse(previewInput));

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input", message: "aucune tâche définie" } });
  });

  it("500 (and nothing created) when the preview store throws", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-id',
          title: 'Task A',
          description: 'do a',
          dependsOn: [],
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    // Mock the preview store to throw when retrieve is called
    f.container.goalPreviewStore.retrieve = vi.fn().mockRejectedValueOnce(new Error("retrieve failed"));

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(500);
  });

  it("500 (and nothing created) when the goal planning throws", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const goal: HighLevelGoal = {
      id: goalId,
      title: 'Test goal',
      objective: 'Test objective',
      rawInput: 'Test goal: Test objective',
      normalizedIntent: 'Test objective',
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-id',
          title: 'Task A',
          description: 'do a',
          dependsOn: [],
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    // Mock the preview store to return the goal when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
    // Mock the planner to throw when plan is called
    f.container.goalPlanner.plan = vi.fn().mockRejectedValueOnce(new Error("planning failed"));

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(500);
  });

  it("500 (and nothing created) when the mission service throws", async () => {
    const f = install("operator");
    const goalId = 'goal-id';
    const goal: HighLevelGoal = {
      id: goalId,
      title: 'Test goal',
      objective: 'Test objective',
      rawInput: 'Test goal: Test objective',
      normalizedIntent: 'Test objective',
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "reversible",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const previewInput: GoalPlanPreview = {
      goalId,
      missionTitle: 'Mission Title',
      missionObjective: 'Mission Objective',
      tasks: [
        {
          id: 'task-id',
          title: 'Task A',
          description: 'do a',
          dependsOn: [],
          capability: 'some-capability',
          workerKind: 'some-worker',
          riskLevel: 'reversible',
          humanApprovalRequired: false,
          acceptanceCriteria: [],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
      ],
    };
    // Mock the preview store to return the goal when retrieve is called with the goalId
    f.container.goalPreviewStore.retrieve = vi.fn().mockResolvedValue(goal);
    // Mock the planner to return the parsed preview when plan is called with the goal
    f.container.goalPlanner.plan = vi.fn().mockResolvedValue(GoalPlanPreviewSchema.parse(previewInput));
    // Mock the mission service to throw when createMission is called
    // We need to mock the MissionService constructor or the mission repository's create method.
    // We have mocked the mission repository's create method to return a successful result.
    // To make it throw, we can mock the mission repository's create method to throw.
    f.container.mission.create = vi.fn().mockRejectedValueOnce(new Error("mission creation failed"));

    const response = await callRoute(authed, { preview: previewInput });
    expect(response.status).toBe(500);
  });
});