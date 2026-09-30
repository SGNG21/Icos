import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import type { InMemoryControlStore } from "@/server/control/in-memory-control-store";

/**
 * HTTP surface of the control plane (decision 0055): the routes add
 * authentication, CSRF and session evidence; the bus decides everything else.
 */
const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

type Who = Role | "anonymous";

async function install(who: Who, opts: { evidence?: boolean; password?: string } = {}) {
  const session: AuthenticatedSession | null =
    who === "anonymous"
      ? null
      : { user: { id: "human-1", email: "h@icos.test", status: "active" }, roles: [who] };
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
    readSessionEvidence:
      opts.evidence === false
        ? async () => null
        : async () =>
            session ? { sessionId: "sess-1", userId: session.user.id, issuedAt: new Date() } : null,
    verifyPassword: async (_h, p) => p === (opts.password ?? "right"),
  };
  const base = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
  const container: Container = { ...base, auth };
  // Re-auth in the route goes through the container's auth gateway.
  const { composeControlPlane } = await import("@/server/control/compose");
  container.control = composeControlPlane({
    store: base.control!.store,
    guard: base.control!.guard,
    effects: {
      missions: base.mission,
      tasks: base.tasks,
      workers: base.workerRegistryStore,
      registration: base.workerRegistration,
    },
    auth,
  });
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  const mission = await base.mission.create({
    title: "M",
    objective: "o",
    tasks: [{ title: "t", dependsOn: [] }],
  });
  return { container, mission, store: base.control!.store as InMemoryControlStore };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.restoreAllMocks();
});

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { origin: ORIGIN, cookie: COOKIE },
) {
  const mod =
    path === "/api/control/commands"
      ? await import("./commands/route")
      : await import("./reauth/route");
  return mod.POST(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const pause = (missionId: string, expectedVersion = 0) => ({
  idempotencyKey: randomUUID(),
  type: "PAUSE_MISSION",
  target: { kind: "mission", id: missionId },
  expectedVersion,
  reason: "operator decision",
});

describe("POST /api/control/commands", () => {
  it("401 without a session: nothing changes", async () => {
    const f = await install("anonymous");
    const res = await post("/api/control/commands", pause(f.mission.id), { origin: ORIGIN });
    expect(res.status).toBe(401);
    expect(await f.store.isHeld(f.mission.id)).toBe(false);
  });

  it("403 on a cross-origin request (CSRF): nothing changes", async () => {
    const f = await install("owner");
    const res = await post("/api/control/commands", pause(f.mission.id), {
      origin: "https://evil.example",
      cookie: COOKIE,
    });
    expect(res.status).toBe(403);
    expect(await f.store.isHeld(f.mission.id)).toBe(false);
  });

  it("fails closed without session evidence", async () => {
    const f = await install("owner", { evidence: false });
    expect((await post("/api/control/commands", pause(f.mission.id))).status).toBe(401);
    expect(await f.store.isHeld(f.mission.id)).toBe(false);
  });

  it("403 typed FORBIDDEN for a viewer, and the attempt is audited", async () => {
    const f = await install("viewer");
    const res = await post("/api/control/commands", pause(f.mission.id));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      status: "REJECTED",
      rejection: { code: "FORBIDDEN" },
      riskClass: "LOW",
    });
    expect(f.store.audit.map((e) => e.eventType)).toEqual(["control.command.rejected"]);
  });

  it("400 on an invalid body, audited, with no client-chosen risk or actor accepted", async () => {
    const f = await install("owner");
    const res = await post("/api/control/commands", {
      ...pause(f.mission.id),
      riskClass: "LOW",
      actor: "someone-else",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
    const audit = await f.container.audit.list();
    expect(
      audit.some(
        (e) =>
          e.id === body.error.details.auditEntryId && e.eventType === "control.command.rejected",
      ),
    ).toBe(true);
  });

  it("200 EXECUTED with version and audit evidence; then 409 VERSION_CONFLICT on a stale version", async () => {
    const f = await install("owner");
    const ok = await post("/api/control/commands", pause(f.mission.id));
    expect(ok.status).toBe(200);
    const result = await ok.json();
    expect(result).toMatchObject({
      status: "EXECUTED",
      version: 1,
      reauth: "NOT_REQUIRED",
      replayed: false,
    });
    expect(result.auditEntryId).toMatch(/^ctl-/);

    const stale = await post("/api/control/commands", {
      ...pause(f.mission.id),
      type: "RESUME_MISSION",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      rejection: { code: "VERSION_CONFLICT" },
      version: 1,
    });
  });

  it("428 REAUTH_REQUIRED for a HIGH command, then 200 with a proof from /api/control/reauth", async () => {
    const f = await install("owner");
    const cancel = {
      idempotencyKey: randomUUID(),
      type: "CANCEL_MISSION",
      target: { kind: "mission", id: f.mission.id },
      expectedVersion: 0,
      reason: "stop it",
    };
    const needs = await post("/api/control/commands", cancel);
    expect(needs.status).toBe(428);
    expect(await needs.json()).toMatchObject({
      reauth: "REQUIRED",
      rejection: { code: "REAUTH_REQUIRED" },
    });

    expect((await post("/api/control/reauth", { password: "wrong" })).status).toBe(401);
    const reauth = await post("/api/control/reauth", { password: "right" });
    expect(reauth.status).toBe(200);
    const { proof, expiresAt } = await reauth.json();
    expect(typeof proof).toBe("string");
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const done = await post("/api/control/commands", {
      ...cancel,
      idempotencyKey: randomUUID(),
      reauthProof: proof,
    });
    expect(done.status).toBe(200);
    expect((await f.container.mission.findById(f.mission.id))!.status).toBe("cancelled");
    expect(JSON.stringify(await f.container.audit.list())).not.toContain(proof);
  });
});

describe("GET /api/control/commands/:id and /api/control/state", () => {
  it("returns the stored result and current versions", async () => {
    const f = await install("owner");
    const executed = await (await post("/api/control/commands", pause(f.mission.id))).json();

    const { GET: getCommand } = await import("./commands/[id]/route");
    const res = await getCommand(
      new Request(`${ORIGIN}/api/control/commands/${executed.commandId}`, {
        headers: { cookie: COOKIE },
      }),
      {
        params: Promise.resolve({ id: executed.commandId }),
      },
    );
    expect(await res.json()).toMatchObject({
      commandId: executed.commandId,
      status: "EXECUTED",
      replayed: true,
    });

    const { GET: getState } = await import("./state/route");
    const state = await (
      await getState(
        new Request(`${ORIGIN}/api/control/state?missionId=${f.mission.id}`, {
          headers: { cookie: COOKIE },
        }),
      )
    ).json();
    expect(state).toMatchObject({
      runtime: { stored: { safeMode: false }, effective: { dispatchEnabled: true }, version: 0 },
      missions: [{ id: f.mission.id, held: true, version: 1 }],
    });
  });
});
