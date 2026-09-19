import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

import { GET as listMissions } from "./route";
import { GET as getMission } from "./[id]/route";
import { POST as decideApproval } from "./[id]/approval/route";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

type Access = Role | "no-role" | "anonymous" | "expired";

async function install(access: Access, opts: { awaitingApproval?: boolean } = {}) {
  const session: AuthenticatedSession | null =
    access === "anonymous" || access === "expired"
      ? null
      : {
          user: { id: "human-1", email: "h@icos.test", name: "H", status: "active" },
          roles: access === "no-role" ? [] : [access],
        };
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const base = buildMemoryContainer();
  const container: Container = { ...base, auth };
  const mission = await container.mission.create({ title: "M", objective: "O", tasks: [] });
  if (opts.awaitingApproval) await container.mission.updateMissionStatus(mission.id, "awaiting_approval");
  const spies = {
    list: vi.spyOn(container.mission, "list"),
    findById: vi.spyOn(container.mission, "findById"),
    updateStatus: vi.spyOn(container.mission, "updateMissionStatus"),
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return { container, mission, spies };
}

const headers = (o: Record<string, string> = {}) => ({ origin: ORIGIN, cookie: COOKIE, ...o });
const get = (path: string, h: Record<string, string> = headers()) =>
  new Request(`${ORIGIN}${path}`, { headers: h }) as never;
const post = (path: string, body: unknown, h: Record<string, string> = headers()) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...h },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/missions", () => {
  it("401 for anonymous and expired sessions, without reading any mission", async () => {
    for (const access of ["anonymous", "expired"] as const) {
      const f = await install(access);
      const response = await listMissions(get("/api/missions", access === "anonymous" ? { origin: ORIGIN } : headers()));
      expect(response.status).toBe(401);
      expect(f.spies.list).not.toHaveBeenCalled();
    }
  });

  it("403 for an authenticated user without permission, without reading any mission", async () => {
    const f = await install("no-role");
    expect((await listMissions(get("/api/missions"))).status).toBe(403);
    expect(f.spies.list).not.toHaveBeenCalled();
  });

  it("200 with the grouped missions for a viewer (existing contract)", async () => {
    await install("viewer");
    const response = await listMissions(get("/api/missions"));
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json())).toEqual(
      expect.arrayContaining(["active", "blocked", "awaitingApproval", "succeededRecent", "failedRecent"]),
    );
  });
});

describe("GET /api/missions/[id]", () => {
  it("401 for anonymous and expired sessions, without reading the mission", async () => {
    for (const access of ["anonymous", "expired"] as const) {
      const f = await install(access);
      const response = await getMission(
        get("/api/missions/x", access === "anonymous" ? { origin: ORIGIN } : headers()),
        params(f.mission.id),
      );
      expect(response.status).toBe(401);
      expect(f.spies.findById).not.toHaveBeenCalled();
    }
  });

  it("403 without permission", async () => {
    const f = await install("no-role");
    expect((await getMission(get("/api/missions/x"), params(f.mission.id))).status).toBe(403);
    expect(f.spies.findById).not.toHaveBeenCalled();
  });

  it("200 for a viewer, 404 for an unknown id (existing contract); audit timeline needs audit.read.full", async () => {
    const f = await install("viewer");
    const ok = await getMission(get("/api/missions/x"), params(f.mission.id));
    expect(ok.status).toBe(200);
    const viewerBody = (await ok.json()) as { mission: { id: string }; timeline: unknown[] };
    expect(viewerBody.mission.id).toBe(f.mission.id);
    expect(viewerBody.timeline).toEqual([]); // viewers have no audit.read.full

    expect((await getMission(get("/api/missions/x"), params("ghost"))).status).toBe(404);

    const op = await install("operator");
    const operator = await getMission(get("/api/missions/x"), params(op.mission.id));
    expect(operator.status).toBe(200);
    expect(Array.isArray(((await operator.json()) as { timeline: unknown[] }).timeline)).toBe(true);
  });
});

describe("POST /api/missions/[id]/approval", () => {
  const approve = { action: "approve" };

  async function expectUnchanged(f: Awaited<ReturnType<typeof install>>) {
    expect(f.spies.updateStatus).not.toHaveBeenCalled();
    expect((await f.container.mission.findById(f.mission.id))?.status).toBe("awaiting_approval");
  }

  it("401 anonymous / expired: the mission is never modified", async () => {
    for (const access of ["anonymous", "expired"] as const) {
      const f = await install(access, { awaitingApproval: true });
      const h = access === "anonymous" ? { origin: ORIGIN } : headers();
      const response = await decideApproval(post("/x", approve, h), params(f.mission.id));
      expect(response.status).toBe(401);
      await expectUnchanged(f);
    }
  });

  it("403 for a viewer (no approvals.decide) and for a cross-origin mutation: the mission is never modified", async () => {
    const viewer = await install("viewer", { awaitingApproval: true });
    expect((await decideApproval(post("/x", approve), params(viewer.mission.id))).status).toBe(403);
    await expectUnchanged(viewer);

    const cross = await install("operator", { awaitingApproval: true });
    const response = await decideApproval(post("/x", approve, headers({ origin: "http://evil.test" })), params(cross.mission.id));
    expect(response.status).toBe(403);
    await expectUnchanged(cross);
  });

  it("authorization comes before body parsing and lookup: anonymous + invalid body is 401, never 400/404", async () => {
    await install("anonymous");
    expect((await decideApproval(post("/x", "{bad", { origin: ORIGIN }), params("ghost"))).status).toBe(401);
  });

  it("operator: approve -> running, reject -> cancelled (existing contract)", async () => {
    const a = await install("operator", { awaitingApproval: true });
    const approved = await decideApproval(post("/x", approve), params(a.mission.id));
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { mission: { status: string } }).mission.status).toBe("running");

    const r = await install("owner", { awaitingApproval: true });
    const rejected = await decideApproval(post("/x", { action: "reject" }), params(r.mission.id));
    expect(((await rejected.json()) as { mission: { status: string } }).mission.status).toBe("cancelled");
  });

  it("keeps the legitimate error contracts: 400 invalid action / invalid JSON / not awaiting, 404 unknown", async () => {
    const f = await install("operator", { awaitingApproval: true });
    expect((await decideApproval(post("/x", { action: "explode" }), params(f.mission.id))).status).toBe(400);
    expect((await decideApproval(post("/x", "{bad"), params(f.mission.id))).status).toBe(400);
    expect((await decideApproval(post("/x", approve), params("ghost"))).status).toBe(404);

    const notAwaiting = await install("operator");
    expect((await decideApproval(post("/x", approve), params(notAwaiting.mission.id))).status).toBe(400);
  });
});

describe("every API route is guarded", () => {
  const ROOT = join(process.cwd(), "src", "app", "api");
  // Public by design: the login/logout endpoint (own origin + credential checks).
  const PUBLIC = new Set(["auth/[...all]/route.ts"]);
  const GUARDS = /\b(protectRoute|requirePermission|requireRole|requireSession|verifyExecutionCallback)\s*\(/g;
  const HANDLERS = /^export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/gm;

  const routes = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return routes(path);
      return name === "route.ts" ? [path] : [];
    });

  it("has no API route handler without a guard (only the login endpoint is public)", () => {
    const offenders: string[] = [];
    for (const file of routes(ROOT)) {
      const rel = file.replace(`${ROOT}/`, "");
      if (PUBLIC.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      const handlers = [...source.matchAll(HANDLERS)].length;
      const guards = [...source.matchAll(GUARDS)].length;
      if (guards < handlers) offenders.push(`${rel} (${guards} guard(s) for ${handlers} handler(s))`);
    }
    expect(offenders).toEqual([]);
  });

  it("guards every /api/missions* handler with protectRoute and an explicit permission", () => {
    const missionRoutes = routes(join(ROOT, "missions"));
    expect(missionRoutes.length).toBeGreaterThanOrEqual(4);
    for (const file of missionRoutes) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(/protectRoute\(/);
      expect(source, file).toMatch(/permission:\s*"/);
    }
  });
});
