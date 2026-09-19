import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/core/contracts";
import type { AuthenticatedSession, Role } from "@/core/identity";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

import { GET as listMissions } from "./route";
import { GET as getMission } from "./[id]/route";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";

type Options = { role: Role; linked?: string[]; operationalAccess?: unknown };

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

  /** Running mission whose canonical tasks are assigned to the given agents (null = unassigned). */
  async function mission(title: string, assignees: Array<string | null>) {
    const created = await container.mission.create({
      title,
      objective: `secret objective of ${title}`,
      tasks: assignees.map((_, i) => ({
        title: `${title}-T${i}`,
        description: `d${i}`,
        dependsOn: [],
        workerKind: "agent",
      })),
    });
    const store = (container.tasks as unknown as { tasks: Task[] }).tasks;
    for (const [i, mt] of (await container.mission.listTasks(created.id)).entries()) {
      if (assignees[i] !== null)
        store.find((t) => t.id === mt.taskId)!.assignedAgentId = assignees[i]!;
    }
    await container.mission.updateMissionStatus(created.id, "running");
    return created;
  }
  return { container, mission };
}

const request = (path: string) =>
  new Request(`${ORIGIN}${path}`, {
    headers: { origin: ORIGIN, cookie: "icos.session_token=opaque-test-value" },
  }) as never;
const list = () => listMissions(request("/api/missions"));
const detail = (id: string) =>
  getMission(request(`/api/missions/${id}`), { params: Promise.resolve({ id }) });

type Groups = Record<string, Array<{ id: string; title: string }>>;
const listedIds = async (response: Response) =>
  Object.values((await response.json()) as Groups)
    .flat()
    .map((m) => m.id)
    .sort();

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/missions — operational scope", () => {
  async function fixture(options: Options) {
    const f = await install(options);
    const a = await f.mission("Alpha", ["agent-a"]);
    const b = await f.mission("Bravo", ["agent-b"]);
    const mixed = await f.mission("Mixed", ["agent-a", "agent-b"]);
    const open = await f.mission("Open", [null]);
    const empty = await f.mission("Empty", []);
    return { ...f, a, b, mixed, open, empty };
  }

  it("a viewer linked to agent A sees A, unassigned and empty missions, never B or a mixed one", async () => {
    const f = await fixture({ role: "viewer", linked: ["agent-a"] });
    const response = await list();
    expect(response.status).toBe(200);
    expect(await listedIds(response)).toEqual([f.a.id, f.open.id, f.empty.id].sort());
  });

  it("does not leak any metadata of out-of-scope missions (id, title, objective, counts)", async () => {
    const f = await fixture({ role: "viewer", linked: ["agent-a"] });
    const text = JSON.stringify(await (await list()).json());
    for (const hidden of [f.b, f.mixed]) {
      expect(text).not.toContain(hidden.id);
      expect(text).not.toContain(hidden.title);
      expect(text).not.toContain(hidden.objective);
    }
  });

  it("a viewer linked to agent B sees the mirror image", async () => {
    const f = await fixture({ role: "viewer", linked: ["agent-b"] });
    expect(await listedIds(await list())).toEqual([f.b.id, f.open.id, f.empty.id].sort());
  });

  it("a viewer with no linked agent only sees unassigned and empty missions", async () => {
    const f = await fixture({ role: "viewer", linked: [] });
    expect(await listedIds(await list())).toEqual([f.open.id, f.empty.id].sort());
  });

  it.each(["admin", "owner"] as const)(
    "%s keeps the unrestricted view (global scope)",
    async (role) => {
      const f = await fixture({ role, linked: [] });
      expect(await listedIds(await list())).toEqual(
        [f.a.id, f.b.id, f.mixed.id, f.open.id, f.empty.id].sort(),
      );
    },
  );

  it("fails closed without an OperationalAccessService: minimum scope", async () => {
    const f = await fixture({ role: "viewer" });
    expect(await listedIds(await list())).toEqual([f.open.id, f.empty.id].sort());
  });

  it("fails closed on an invalid scope shape", async () => {
    const f = await fixture({
      role: "viewer",
      operationalAccess: { resolveScope: async () => ({ kind: "everything" }) },
    });
    expect(await listedIds(await list())).toEqual([f.open.id, f.empty.id].sort());
  });

  it("fails closed (500, no missions) when the scope cannot be resolved", async () => {
    const f = await fixture({
      role: "viewer",
      operationalAccess: {
        resolveScope: async () => {
          throw new Error("links unavailable");
        },
      },
    });
    const response = await list();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(f.a.title);
  });
});

describe("GET /api/missions/[id] — operational scope", () => {
  it("in scope: full detail (existing contract)", async () => {
    const f = await install({ role: "viewer", linked: ["agent-a"] });
    const a = await f.mission("Alpha", ["agent-a"]);
    const response = await detail(a.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mission: { id: string; title: string };
      tasks: unknown[];
      progression: { total: number };
    };
    expect(body.mission).toMatchObject({ id: a.id, title: "Alpha" });
    expect(body.tasks).toHaveLength(1);
    expect(body.progression.total).toBe(1);
  });

  it("out of scope: 404 identical to an unknown mission, with no metadata and no audit read", async () => {
    const f = await install({ role: "operator", linked: ["agent-a"] });
    const b = await f.mission("Bravo", ["agent-b"]);
    const auditList = vi.spyOn(f.container.audit, "list");

    const denied = await detail(b.id);
    const unknown = await detail("ghost");
    expect(denied.status).toBe(404);
    expect(await denied.clone().json()).toEqual(await unknown.json());
    const text = await denied.text();
    for (const secret of [b.id, "Bravo", b.objective, "Bravo-T0"])
      expect(text).not.toContain(secret);
    expect(auditList).not.toHaveBeenCalled();
  });

  it("a mixed mission is out of scope", async () => {
    const f = await install({ role: "viewer", linked: ["agent-a"] });
    const mixed = await f.mission("Mixed", ["agent-a", "agent-b"]);
    expect((await detail(mixed.id)).status).toBe(404);
  });

  it.each(["admin", "owner"] as const)(
    "%s keeps the unrestricted view of any mission",
    async (role) => {
      const f = await install({ role, linked: [] });
      const b = await f.mission("Bravo", ["agent-b"]);
      expect((await detail(b.id)).status).toBe(200);
    },
  );

  it("fails closed without a scope service, on an invalid scope, and on a resolution error (no data)", async () => {
    const none = await install({ role: "viewer" });
    const b1 = await none.mission("Bravo", ["agent-b"]);
    expect((await detail(b1.id)).status).toBe(404);

    const invalid = await install({
      role: "viewer",
      operationalAccess: { resolveScope: async () => null },
    });
    const b2 = await invalid.mission("Bravo", ["agent-b"]);
    expect((await detail(b2.id)).status).toBe(404);

    const broken = await install({
      role: "viewer",
      operationalAccess: {
        resolveScope: async () => {
          throw new Error("links unavailable");
        },
      },
    });
    const m = await broken.mission("Open", [null]);
    const response = await detail(m.id);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("Open");
  });

  it("keeps audit.read.full for the detailed timeline inside the scope", async () => {
    const viewer = await install({ role: "viewer", linked: ["agent-a"] });
    const a = await viewer.mission("Alpha", ["agent-a"]);
    const auditList = vi.spyOn(viewer.container.audit, "list");
    expect(((await (await detail(a.id)).json()) as { timeline: unknown[] }).timeline).toEqual([]);
    expect(auditList).not.toHaveBeenCalled();

    const operator = await install({ role: "operator", linked: ["agent-a"] });
    const a2 = await operator.mission("Alpha", ["agent-a"]);
    const operatorAudit = vi.spyOn(operator.container.audit, "list");
    expect(
      Array.isArray(((await (await detail(a2.id)).json()) as { timeline: unknown[] }).timeline),
    ).toBe(true);
    expect(operatorAudit).toHaveBeenCalledTimes(1);
  });
});
