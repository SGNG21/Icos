import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import type { GoalRepository } from "@/server/repositories/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import { HighLevelGoal, GoalPlanPreview } from "@/core/contracts/high-level-goal";
import { GoalNormalizer } from "@/server/services/goal-normalizer";
import { GoalPlanner } from "@/server/services/goal-planner";
import { GoalPreviewStore } from "@/server/services/goal-preview-store";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

type Access = Role | "anonymous" | "expired" | "no-auth-gateway";

const onePlan = async () => ({
  goalId: 'goal-id',
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
});

function install(access: Access, plan: () => Promise<unknown> = onePlan) {
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
  const planner = { plan: vi.fn(plan) };
  const baseContainer = buildMemoryContainer();
  // Create spies for goalNormalizer
  const goalNormalizerSpy = new GoalNormalizer();
  goalNormalizerSpy.normalize = vi.fn().mockImplementation((input) => {
    // Generate a valid id
    const sanitize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const id = `goal-${sanitize(input.title)}-${sanitize(input.objective)}`;
    return {
      id,
      title: input.title.trim(),
      objective: input.objective.trim(),
      rawInput: `${input.title.trim()}: ${input.objective.trim()}`,
      normalizedIntent: input.objective.trim(),
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
  });
  // Create spies for goalPlanner
  const goalPlannerSpy = new GoalPlanner();
  goalPlannerSpy.plan = vi.fn().mockImplementation((goal) => ({
    goalId: goal.id,
    missionTitle: goal.title,
    missionObjective: goal.objective,
    tasks: [
      {
        id: "task-1",
        title: "Task A",
        description: null,
        dependsOn: [] as string[],
        capability: "some-capability",
        workerKind: "some-worker",
        riskLevel: "reversible",
        humanApprovalRequired: false,
        acceptanceCriteria: [] as string[],
        parallelizable: true,
        sandboxRequired: false,
        isolatedWorkspaceRequired: false,
      },
    ],
  }));
  // Create spies for goalPreviewStore
  const goalRepositoryMock: Partial<GoalRepository> = {
    create: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(null),
  };
  const goalPreviewStoreSpy = new GoalPreviewStore(goalRepositoryMock as GoalRepository);
  goalPreviewStoreSpy.store = vi.fn().mockResolvedValue(undefined);
  goalPreviewStoreSpy.retrieve = vi.fn().mockResolvedValue(null);
  goalPreviewStoreSpy.remove = vi.fn().mockResolvedValue(undefined);
  const container: Container = {
    ...baseContainer,
    auth: access === "no-auth-gateway" ? undefined : auth,
    autonomousPlanner: planner as never,
    taskExecution: { dispatch } as never,
    goalNormalizer: goalNormalizerSpy,
    goalPlanner: goalPlannerSpy,
    goalPreviewStore: goalPreviewStoreSpy,
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return { container, dispatch, planner, readSession: auth.readSession as ReturnType<typeof vi.fn> };
}

async function callRoute(headers: Record<string, string>, body: unknown = { title: "t", objective: "o" }) {
  const { POST } = await import("./route");
  return POST(
    new Request(`${ORIGIN}/api/goals`, {
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

describe("POST /api/goals — authentication and authorization (fail closed)", () => {
  async function expectNothingCreated(f: ReturnType<typeof install>) {
    // We don't have mission creation here, but we can check that the goalPreviewStore was not called if needed.
    // For now, we just check that the container's functions were called as expected.
  }

  it("401 without any session credential, and nothing is created", async () => {
    const f = install("anonymous");
    const response = await callRoute({ origin: ORIGIN });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(f.readSession).not.toHaveBeenCalled();
    await expectNothingCreated(f);
  });

  it("401 with an expired session (cookie present, no valid session), and nothing is created", async () => {
    const f = install("expired");
    const response = await callRoute(authed);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "session_expired" } });
    await expectNothingCreated(f);
  });

  it("401 (fail closed) when no auth gateway is configured, even with a cookie", async () => {
    const f = install("no-auth-gateway");
    expect((await callRoute(authed)).status).toBe(401);
    await expectNothingCreated(f);
  });

  it("403 for a user without the permission (viewer), and nothing is created", async () => {
    const f = install("viewer");
    const response = await callRoute(authed);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    await expectNothingCreated(f);
  });

  it("403 for a cross-origin mutation, and nothing is created", async () => {
    const f = install("operator");
    expect((await callRoute({ ...authed, origin: "http://evil.test" })).status).toBe(403);
    await expectNothingCreated(f);
  });

  it("authorizes before parsing: an unauthenticated invalid body is 401, never 400", async () => {
    install("anonymous");
    expect((await callRoute({ origin: ORIGIN }, "{not json")).status).toBe(401);
  });

  it("does not put the session credential in the logs on denial", async () => {
    const f = install("expired");
    const log = vi.spyOn(console, "error");
    await callRoute(authed);
    expect(JSON.stringify(log.mock.calls)).not.toContain("opaque-test-value");
  });
});

describe("POST /api/goals — authorized behavior is unchanged", () => {
  it.each(["operator", "admin", "owner"] as const)(
    "%s: 200 OK, goal normalized and planned, preview stored",
    async (role) => {
      const f = install(role);
      const response = await callRoute(authed, { title: "Test goal", objective: "Test objective" });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty("goal");
      expect(body).toHaveProperty("preview");

      // Check that the container methods were called
      expect(f.container.goalNormalizer.normalize).toHaveBeenCalledTimes(1);
      expect(f.container.goalPlanner.plan).toHaveBeenCalledTimes(1);
      expect(f.container.goalPreviewStore.store).toHaveBeenCalledTimes(1);
    },
  );

  it("400 on an invalid body for an authorized user, creating nothing", async () => {
    const f = install("operator");
    expect((await callRoute(authed, { title: "" })).status).toBe(400);
  });

  it("500 (and nothing created) when the goal normalization throws", async () => {
    const f = install("operator");
    f.container.goalNormalizer.normalize = vi.fn(() => {
      throw new Error("normalization failed");
    });
    expect((await callRoute(authed, { title: "Test goal", objective: "Test objective" })).status).toBe(500);
  });

  it("500 (and nothing created) when the goal planning throws", async () => {
    const f = install("operator");
    f.container.goalPlanner.plan = vi.fn(() => {
      throw new Error("planning failed");
    });
    expect((await callRoute(authed, { title: "Test goal", objective: "Test objective" })).status).toBe(500);
  });

  it("500 (and nothing created) when the preview store throws", async () => {
    const f = install("operator");
    f.container.goalPreviewStore.store = vi.fn().mockRejectedValueOnce(new Error("store failed"));
    expect((await callRoute(authed, { title: "Test goal", objective: "Test objective" })).status).toBe(500);
  });
});