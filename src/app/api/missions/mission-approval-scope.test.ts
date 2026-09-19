import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { Task } from "@/core/contracts";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

import { POST as decideApproval } from "./[id]/approval/route";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";

type Options = {
  role: Role;
  /** Agents linked to the human; `undefined` = no OperationalAccessService in the container. */
  linked?: string[];
  operationalAccess?: unknown;
};

async function install({ role, linked, operationalAccess }: Options) {
  const session: AuthenticatedSession = {
    user: { id: "human-1", email: "h@icos.test", name: "H", status: "active" },
    roles: [role],
  };
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session.user,
    readHumanUserByEmail: async () => session.user,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const container = {
    ...buildMemoryContainer(),
    auth,
    operationalAccess:
      operationalAccess ??
      (linked === undefined
        ? undefined
        : new OperationalAccessService({
            listAgentIdsForHuman: async () => new Set(linked),
          } as never)),
  } as Container;
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  const updateStatus = vi.spyOn(container.mission, "updateMissionStatus");

  /** Mission awaiting approval whose canonical tasks are assigned to the given agents (null = unassigned). */
  async function mission(assignees: Array<string | null>, status: "awaiting_approval" | "running" = "awaiting_approval") {
    const created = await container.mission.create({
      title: "M",
      objective: "O",
      tasks: assignees.map((_, i) => ({ title: `T${i}`, description: `d${i}`, dependsOn: [], workerKind: "agent" })),
    });
    const missionTasks = await container.mission.listTasks(created.id);
    const store = (container.tasks as unknown as { tasks: Task[] }).tasks;
    missionTasks.forEach((mt, i) => {
      const canonical = store.find((t) => t.id === mt.taskId)!;
      if (assignees[i] !== null) canonical.assignedAgentId = assignees[i]!;
    });
    await container.mission.updateMissionStatus(created.id, status);
    updateStatus.mockClear();
    return { id: created.id, missionTasks, store };
  }
  const statusOf = async (id: string) => (await container.mission.findById(id))?.status;
  return { container, mission, statusOf, updateStatus };
}

const approve = (id: string, action = "approve") =>
  decideApproval(
    new Request(`${ORIGIN}/api/missions/${id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: "icos.session_token=opaque-test-value" },
      body: JSON.stringify({ action }),
    }) as never,
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/missions/[id]/approval — operational scope", () => {
  it("in scope: an operator linked to the agent approves (existing behavior)", async () => {
    const f = await install({ role: "operator", linked: ["agent-a"] });
    const m = await f.mission(["agent-a"]);
    const response = await approve(m.id);
    expect(response.status).toBe(200);
    expect(await f.statusOf(m.id)).toBe("running");
  });

  it("in scope: unassigned tasks stay visible to any scope (same rule as tasks)", async () => {
    const f = await install({ role: "operator", linked: [] });
    const m = await f.mission([null, null]);
    expect((await approve(m.id)).status).toBe(200);
  });

  it("out of scope: refused with the same 404 as an unknown mission, and nothing is mutated", async () => {
    const f = await install({ role: "operator", linked: ["agent-a"] });
    const m = await f.mission(["agent-b"]);

    const denied = await approve(m.id);
    const unknown = await approve("ghost");
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual(await unknown.json()); // no existence oracle
    expect(f.updateStatus).not.toHaveBeenCalled();
    expect(await f.statusOf(m.id)).toBe("awaiting_approval");
  });

  it("a mission is in scope only if ALL its tasks are: a mixed mission is refused", async () => {
    const f = await install({ role: "operator", linked: ["agent-a"] });
    const m = await f.mission(["agent-a", "agent-b"]);
    expect((await approve(m.id, "reject")).status).toBe(404);
    expect(f.updateStatus).not.toHaveBeenCalled();
    expect(await f.statusOf(m.id)).toBe("awaiting_approval");
  });

  it("scope is checked before the mission state: out of scope + not awaiting is 404, never 400", async () => {
    const f = await install({ role: "operator", linked: ["agent-a"] });
    const m = await f.mission(["agent-b"], "running");
    expect((await approve(m.id)).status).toBe(404);
  });

  it.each(["admin", "owner"] as const)("%s has a global scope and approves any mission", async (role) => {
    const f = await install({ role, linked: [] });
    const m = await f.mission(["agent-b"]);
    expect((await approve(m.id)).status).toBe(200);
    expect(await f.statusOf(m.id)).toBe("running");
  });

  it("fails closed when a mission task has no readable canonical task", async () => {
    const f = await install({ role: "operator", linked: ["agent-a"] });
    const m = await f.mission(["agent-a"]);
    m.store.splice(0, m.store.length); // dangling reference
    expect((await approve(m.id)).status).toBe(404);
    expect(f.updateStatus).not.toHaveBeenCalled();
  });

  it("fails closed without an OperationalAccessService: minimum scope (no linked agent)", async () => {
    const f = await install({ role: "operator" }); // operationalAccess undefined
    const assigned = await f.mission(["agent-a"]);
    expect((await approve(assigned.id)).status).toBe(404);
    expect(f.updateStatus).not.toHaveBeenCalled();
    const unassigned = await f.mission([null]);
    expect((await approve(unassigned.id)).status).toBe(200); // existing tests keep passing
  });

  it("fails closed on an invalid scope shape", async () => {
    const f = await install({
      role: "operator",
      operationalAccess: { resolveScope: async () => ({ kind: "everything" }) },
    });
    const m = await f.mission(["agent-a"]);
    expect((await approve(m.id)).status).toBe(404);
    expect(f.updateStatus).not.toHaveBeenCalled();
  });

  it("fails closed (no mutation) when the scope cannot be resolved", async () => {
    const f = await install({
      role: "operator",
      operationalAccess: {
        resolveScope: async () => {
          throw new Error("links unavailable");
        },
      },
    });
    const m = await f.mission([null]);
    expect((await approve(m.id)).status).toBe(500);
    expect(f.updateStatus).not.toHaveBeenCalled();
    expect(await f.statusOf(m.id)).toBe("awaiting_approval");
  });
});
