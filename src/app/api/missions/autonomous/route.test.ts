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

async function callRoute(headers: Record<string, string>, body: unknown = { title: "t", objective: "o", goalId: "g-1" }) {
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

describe("POST /api/missions/autonomous — P0: an ENQUEUE onto the one canonical execution authority", () => {
  const dueJobs = async (c: Container) => {
    const claimed = [];
    for (let job = await c.scheduledJobs.claimDue("test", 60_000); job; job = await c.scheduledJobs.claimDue("test", 60_000)) {
      claimed.push(job);
    }
    return claimed;
  };

  it.each(["operator", "admin", "owner"] as const)(
    "%s: 202 with a fixed missionId — a durable start_mission job, and NOTHING executes inside the request",
    async (role) => {
      const f = install(role);
      const response = await callRoute(authed);
      expect(response.status).toBe(202);
      const body = (await response.json()) as { missionId: string; jobId: string; state: string };
      expect(body.state).toBe("scheduled");

      /* Durable before the 202: the job exists and names the mission it will create. */
      const job = await f.container.scheduledJobs.getById(body.jobId);
      expect(job).toMatchObject({ kind: "start_mission", missionId: body.missionId });
      expect(job!.payload).toMatchObject({ title: "t", objective: "o", goalId: "g-1", missionId: body.missionId });

      /* No mission, no runtime, no plan, no dispatch in the request: its lifetime cannot matter. */
      expect(await f.container.mission.list()).toHaveLength(0);
      expect(await f.container.autonomousRuntime.get(body.missionId)).toBeNull();
      expect(f.planner.plan).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );

  it("HTTP DISCONNECT: a request aborted mid-flight still leaves the accepted job durable, for the scheduler", async () => {
    const f = install("operator");
    const { POST } = await import("./route");
    const controller = new AbortController();
    const request = new Request(`${ORIGIN}/api/missions/autonomous`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authed },
      body: JSON.stringify({ title: "t", objective: "o", goalId: "g-1" }),
      signal: controller.signal,
    });
    const pending = POST(request);
    controller.abort();
    const response = await pending;
    const { jobId } = (await response.json()) as { jobId: string };
    /* The client is gone; the intent is not. Nothing it owned was running. */
    expect((await f.container.scheduledJobs.getById(jobId))?.state).toBe("scheduled");
    expect(f.planner.plan).not.toHaveBeenCalled();
  });

  it("DUPLICATE LAUNCH is idempotent per caller key; the same key for other content is 409", async () => {
    const f = install("operator");
    const first = (await (await callRoute({ ...authed, "idempotency-key": "launch-1" })).json()) as {
      missionId: string;
      jobId: string;
      replayed: boolean;
    };
    const again = (await (await callRoute({ ...authed, "idempotency-key": "launch-1" })).json()) as typeof first;
    expect(again).toMatchObject({ missionId: first.missionId, jobId: first.jobId, replayed: true });
    expect(first.replayed).toBe(false);
    expect(await dueJobs(f.container)).toHaveLength(1);

    const conflict = await callRoute(
      { ...authed, "idempotency-key": "launch-1" },
      { title: "other", objective: "o", goalId: "g-1" },
    );
    expect(conflict.status).toBe(409);

    /* Without a key, two calls are two missions — as before. */
    const a = (await (await callRoute(authed)).json()) as { missionId: string };
    const b = (await (await callRoute(authed)).json()) as { missionId: string };
    expect(a.missionId).not.toBe(b.missionId);
  });

  it("API AND SCHEDULER CONVERGE: the accepted job is executed by the canonical runtime's GOVERNED supervisor", async () => {
    const f = install("operator");
    const { missionId } = (await (await callRoute(authed)).json()) as { missionId: string };

    /* Exactly what the production scheduler composes (production-services). */
    const { composeAutonomyRuntime } = await import("@/server/system/production-services");
    const { createSchedulerHandlers } = await import("@/server/scheduler/scheduler-handlers");
    const runtime = composeAutonomyRuntime(f.container);
    /* The canonical supervisor carries the governed workspace coordinator — the API's did not. */
    expect((runtime.supervisor as unknown as { workspaceExecutionCoordinator: unknown }).workspaceExecutionCoordinator).toBe(
      f.container.workspaceExecutionCoordinator,
    );
    expect(f.container.workspaceExecutionCoordinator).toBeDefined();

    const handlers = createSchedulerHandlers({
      ignite: {
        missions: f.container.mission,
        runtimeRepository: f.container.autonomousRuntime!,
        supervisor: runtime.supervisor,
        planner: f.container.autonomousPlanner!,
      },
      missions: f.container.mission,
      wakeup: runtime.wakeup,
    });
    const [job] = await dueJobs(f.container);
    await handlers.start_mission(job!, { signal: new AbortController().signal });

    /* The mission the API named is the one the scheduler created and planned. */
    expect((await f.container.mission.findById(missionId))?.id).toBe(missionId);
    expect(await f.container.mission.listTasks(missionId)).toHaveLength(1);
    expect(f.planner.plan).toHaveBeenCalledTimes(1);
    expect(await f.container.autonomousRuntime!.get(missionId)).not.toBeNull();
  });

  it("NO ALTERNATE AUTHORITY in the HTTP layer: no route constructs a supervisor or runs a runner", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../../../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = readFileSync(file, "utf8");
          if (/new SupervisorService\(|new AutonomousMissionRunner\(|startAutonomousMission\(|igniteAutonomousMission\(/.test(src)) {
            offenders.push(path.relative(root, file));
          }
        }
      }
    };
    walk(path.join(root, "app"));
    walk(path.join(root, "server", "http"));
    expect(offenders).toEqual([]);
  });

  it("400 on an invalid body for an authorized user, enqueuing nothing", async () => {
    const f = install("operator");
    expect((await callRoute(authed, { title: "" })).status).toBe(400);
    expect(await dueJobs(f.container)).toHaveLength(0);
  });

  it("503 (fail closed, nothing enqueued) when no planner is configured", async () => {
    const f = install("operator");
    (f.container as { autonomousPlanner?: unknown }).autonomousPlanner = undefined;
    expect((await callRoute(authed)).status).toBe(503);
    expect(await dueJobs(f.container)).toHaveLength(0);
  });

  it("a long caller key is accepted (hashed), and the generic scheduler endpoint cannot pre-claim it", async () => {
    install("operator");
    const long = "k".repeat(900);
    expect((await callRoute({ ...authed, "idempotency-key": long })).status).toBe(202);

    install("admin");
    const { POST } = await import("@/app/api/scheduler/jobs/route");
    const hijack = await POST(
      new Request(`${ORIGIN}/api/scheduler/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authed },
        body: JSON.stringify({
          kind: "start_mission",
          payload: { title: "t", objective: "o" },
          idempotencyKey: "api.missions.autonomous:human-1:abc",
        }),
      }),
    );
    expect(hijack.status).toBe(400);
  });
});
