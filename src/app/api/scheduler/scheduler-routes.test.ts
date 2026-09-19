import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

import { POST as postJob } from "./jobs/route";
import { GET as getJob } from "./jobs/[id]/route";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

function install(role: Role | null): Container {
  const session: AuthenticatedSession | null = role
    ? { user: { id: "human-1", email: "h@icos.test", name: "H", status: "active" }, roles: [role] }
    : null;
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const container: Container = { ...buildMemoryContainer(), auth };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  postJob(
    new Request(`${ORIGIN}/api/scheduler/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: COOKIE, ...headers },
      body: JSON.stringify(body),
    }),
  );
const job = {
  kind: "start_mission",
  payload: { title: "Report", objective: "Return exactly: OK" },
  idempotencyKey: "daily-1",
};

beforeEach(() => delete (globalThis as Record<string, unknown>)[CONTAINER_KEY]);

describe("POST /api/scheduler/jobs", () => {
  it("denies anonymous callers and roles below admin", async () => {
    install(null);
    expect((await post(job)).status).toBe(401);
    for (const role of ["viewer", "operator"] as const) {
      install(role);
      expect((await post(job)).status).toBe(403);
    }
  });

  it("refuses a cross-origin mutation", async () => {
    install("admin");
    expect((await post(job, { origin: "http://evil.test" })).status).toBe(403);
  });

  it("creates a durable job (201) and replays are idempotent (200, same job and mission id)", async () => {
    const container = install("admin");
    const first = await post({ ...job, runAt: new Date(Date.now() + 60_000).toISOString() });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { job: { id: string; state: string; missionId: string } };
    expect(created.job).toMatchObject({ state: "scheduled" });
    expect(created.job.missionId).toMatch(/^[0-9a-f-]{36}$/);

    const replay = await post({ ...job, runAt: new Date(Date.now() + 60_000).toISOString() });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { job: { id: string } }).job.id).toBe(created.job.id);
    expect(await container.scheduledJobs.getById(created.job.id)).not.toBeNull();
  });

  it("answers 409 when the idempotency key is reused for different content", async () => {
    install("owner");
    await post(job);
    const response = await post({ ...job, payload: { ...job.payload, objective: "different" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "already_exists" } });
  });

  it("answers 400 on invalid bodies", async () => {
    install("admin");
    expect((await post({ ...job, kind: "rm_rf" })).status).toBe(400);
    expect((await post({ ...job, payload: { title: "" } })).status).toBe(400);
    expect((await post({ ...job, extra: true })).status).toBe(400);
    const badJson = await postJob(
      new Request(`${ORIGIN}/api/scheduler/jobs`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie: COOKIE },
        body: "{",
      }),
    );
    expect(badJson.status).toBe(400);
  });
});

describe("GET /api/scheduler/jobs/[id]", () => {
  const get = (id: string) =>
    getJob(new Request(`${ORIGIN}/api/scheduler/jobs/${id}`, { headers: { cookie: COOKIE } }), {
      params: Promise.resolve({ id }),
    });

  it("returns the job state to an admin, 404 for unknown ids, 403 for operators", async () => {
    install("admin");
    const created = (await (await post(job)).json()) as { job: { id: string } };
    const ok = await get(created.job.id);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { job: { id: string; kind: string } }).job).toMatchObject({
      id: created.job.id,
      kind: "start_mission",
    });
    expect((await get("does-not-exist")).status).toBe(404);

    install("operator");
    expect((await get("x")).status).toBe(403);
  });
});
