import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAutonomousMissionRuntimeRepository } from "@/server/services/in-memory/autonomous-mission-runtime-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";

const state = vi.hoisted(() => ({ container: undefined as unknown }));
vi.mock("@/server/container", () => ({ getContainer: async () => state.container }));

import { POST } from "./route";

function containerWith(planner: { plan: () => Promise<unknown> }) {
  const tasks = new InMemoryTaskRepository(new InMemoryAuditLog(), []);
  const mission = new InMemoryMissionRepository(tasks);
  return {
    mission,
    tasks,
    taskExecution: { dispatch: vi.fn() },
    durableMemory: {},
    dispatchAttempts: undefined,
    autonomousRuntime: new InMemoryAutonomousMissionRuntimeRepository(),
    autonomousPlanner: planner,
  };
}

const request = () =>
  new Request("http://localhost/api/missions/autonomous", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "t", objective: "o" }),
  });

describe("POST /api/missions/autonomous when the start fails after the mission was created", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));

  it("answers 202 with the missionId (never a bare 500) so the client does not create a duplicate", async () => {
    const container = containerWith({
      plan: async () => {
        throw new Error("AUTONOMY_PLANNER_PROVIDER_HTTP:503");
      },
    });
    state.container = container;

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ state: "starting", reason: "AUTONOMY_START_DEFERRED" });
    expect(typeof body.missionId).toBe("string");

    // Exactly one mission exists, and its durable runtime is recoverable by the sweeper.
    const created = await container.mission.findById(body.missionId);
    expect(created).not.toBeNull();
    const runtime = await container.autonomousRuntime.get(body.missionId);
    expect(runtime?.state).toBe("running");
    expect(runtime?.ownerToken ?? null).toBeNull();
  });

  it("still answers 500 (and creates nothing) when the mission itself cannot be created", async () => {
    const container = containerWith({ plan: async () => ({}) });
    container.mission.create = async () => {
      throw new Error("db down");
    };
    state.container = container;

    const response = await POST(request());
    expect(response.status).toBe(500);
  });

  it("keeps answering 200 with the runner state on the normal path", async () => {
    const container = containerWith({
      plan: async () => ({
        version: 1,
        tasks: [{ key: "a", title: "A", description: "do a", dependsOn: [] }],
      }),
    });
    state.container = container;
    const dispatch = container.taskExecution.dispatch;
    dispatch.mockResolvedValue({ workflowId: "wf" });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: expect.any(String) });
  });
});
