import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

type Access = Role | "anonymous" | "expired" | "no-auth-gateway";

const onePlan = async () => ({
  version: 1,
  tasks: [{ key: "a", title: "A", description: "do a", dependsOn: [] }],
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
  const container = {
    ...buildMemoryContainer(),
    auth: access === "no-auth-gateway" ? undefined : auth,
    autonomousPlanner: planner as never,
    taskExecution: { dispatch } as never,
  } as Container;
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return { container, dispatch, planner, readSession: auth.readSession as ReturnType<typeof vi.fn> };
}

async function callRoute(headers: Record<string, string>, body: unknown = { title: "t", objective: "o" }) {
  const { POST } = await import("./route");
  return POST(
    new Request(`${ORIGIN}/api/missions/autonomous`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
const authed = { origin: ORIGIN, cookie: COOKIE };

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/missions/autonomous — authentication and authorization (fail closed)", () => {
  async function expectNothingCreated(f: ReturnType<typeof install>) {
    expect(await f.container.mission.list()).toHaveLength(0);
    expect(await f.container.autonomousRuntime.get("anything")).toBeNull();
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
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
    install("expired");
    const log = vi.spyOn(console, "error");
    await callRoute(authed);
    expect(JSON.stringify(log.mock.calls)).not.toContain("opaque-test-value");
  });
});

describe("POST /api/missions/autonomous — authorized behavior is unchanged", () => {
  it.each(["operator", "admin", "owner"] as const)(
    "%s: 202 Accepted, one mission created, planned and dispatched exactly once",
    async (role) => {
      const f = install(role);
      const response = await callRoute(authed);
      expect(response.status).toBe(202);
      const body = (await response.json()) as { missionId: string; state: string };
      expect(body.state).toEqual(expect.any(String));

      const missions = await f.container.mission.list();
      expect(missions).toHaveLength(1);
      expect(missions[0].id).toBe(body.missionId);
      expect(await f.container.mission.listTasks(body.missionId)).toHaveLength(1);
      expect(f.planner.plan).toHaveBeenCalledTimes(1);
      expect(f.dispatch).toHaveBeenCalledTimes(1); // dispatch ledger path intact
      expect(await f.container.autonomousRuntime.get(body.missionId)).not.toBeNull();
    },
  );

  it("still answers 202 'starting' with the missionId when starting fails after creation (recovery resumes it)", async () => {
    const f = install("operator", async () => {
      throw new Error("AUTONOMY_PLANNER_PROVIDER_HTTP:503");
    });
    const response = await callRoute(authed);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { missionId: string };
    expect(body).toMatchObject({ state: "starting", reason: "AUTONOMY_START_DEFERRED" });
    expect((await f.container.autonomousRuntime.get(body.missionId))?.state).toBe("running");
    expect(await f.container.mission.list()).toHaveLength(1);
  });

  it("400 on an invalid body for an authorized user, creating nothing", async () => {
    const f = install("operator");
    expect((await callRoute(authed, { title: "" })).status).toBe(400);
    expect(await f.container.mission.list()).toHaveLength(0);
  });

  it("500 (and nothing created) when the mission itself cannot be created", async () => {
    const f = install("operator");
    f.container.mission.create = async () => {
      throw new Error("db down");
    };
    expect((await callRoute(authed)).status).toBe(500);
  });
});
