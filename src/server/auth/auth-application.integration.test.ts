import { eq } from "drizzle-orm";
import { splitSetCookieHeader } from "better-auth/cookies";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getAgents } from "@/app/api/agents/route";
import { GET as getAudit } from "@/app/api/audit/route";
import { POST as postAuth } from "@/app/api/auth/[...all]/route";
import { POST as postTask } from "@/app/api/tasks/route";
import { loadEnv } from "@/config/env";
import type { Role } from "@/core/identity";
import { createContainer, resetContainer, type Container } from "@/server/container";
import { session as sessionTable, user as userTable } from "@/server/database/auth-schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

const EMAIL = "viewer@icos.test";
const PASSWORD = "correct horse battery staple";
const CONTAINER_KEY = "__icosContainerPromise__";

function authContext(...all: string[]) {
  return { params: Promise.resolve({ all }) };
}

function mutationHeaders(cookie?: string): HeadersInit {
  return {
    "content-type": "application/json",
    origin: "http://localhost:3000",
    "sec-fetch-site": "same-origin",
    ...(cookie ? { cookie } : {}),
  };
}

function signInRequest(email = EMAIL, password = PASSWORD): Request {
  return new Request("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({ email, password }),
  });
}

function requestCookie(response: Response): string {
  const cookie = splitSetCookieHeader(response.headers.get("set-cookie") ?? "")
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("cookie de session absent");
  return cookie;
}

async function createHuman(role: Role, email = `${role}@icos.test`): Promise<string> {
  if (!container.auth || !container.roles) throw new Error("auth non composée");
  const created = await container.auth.createHumanUser({ email, password: PASSWORD });
  if (!created.ok) throw new Error("création humaine refusée");
  await container.roles.grantRole(created.userId, role);
  return created.userId;
}

async function signIn(email = EMAIL): Promise<{ cookie: string; response: Response }> {
  const response = await postAuth(signInRequest(email), authContext("sign-in", "email"));
  return { cookie: requestCookie(response), response };
}

let container: Container;

describe.skipIf(!dockerAvailable)("Application auth (PostgreSQL 16)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
    container = await createContainer({
      env: loadEnv({
        PERSISTENCE: "postgres",
        DATABASE_URL: ctx.container.getConnectionUri(),
        BETTER_AUTH_SECRET: "x".repeat(40),
        BETTER_AUTH_URL: "http://localhost:3000",
      }),
    });
    (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  }, 120_000);

  afterAll(async () => {
    await resetContainer();
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
  });

  it("connecte un humain et persiste un audit sûr sans exposer de token", async () => {
    const userId = await createHuman("viewer", EMAIL);

    const { response } = await signIn();

    expect(response.status).toBe(200);
    expect(response.headers.has("set-cookie")).toBe(true);
    expect(await response.json()).toEqual({ success: true });

    const entries = await container.audit.list();
    expect(entries).toEqual([
      expect.objectContaining({
        eventType: "auth.login.succeeded",
        actor: { kind: "human", id: userId },
        details: {},
      }),
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/password|cookie|token|secret|hash/i);
  });

  it("rejette de mauvais identifiants et persiste un audit système sûr", async () => {
    await createHuman("viewer", EMAIL);

    const response = await postAuth(
      signInRequest(EMAIL, "incorrect password value"),
      authContext("sign-in", "email"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthenticated",
        message: "Authentification requise.",
      },
    });

    const entries = await container.audit.list();
    expect(entries).toEqual([
      expect.objectContaining({
        eventType: "auth.login.rejected",
        actor: { kind: "system", id: "icos-auth" },
        details: { reason: "invalid_credentials" },
      }),
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/password|cookie|token|secret|hash/i);
  });

  it("crée les humains en interne sans créer de session web", async () => {
    await createHuman("owner");

    const rows = await ctx.handle.db.select({ id: sessionTable.id }).from(sessionTable);

    expect(rows).toEqual([]);
  });

  it("applique les permissions viewer aux Route Handlers", async () => {
    await createHuman("viewer", EMAIL);
    const { cookie } = await signIn();

    const readResponse = await getAgents(
      new Request("http://localhost:3000/api/agents", { headers: { cookie } }),
    );
    const mutationResponse = await postTask(
      new Request("http://localhost:3000/api/tasks", {
        method: "POST",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ title: "Interdit au viewer" }),
      }),
    );
    const auditResponse = await getAudit(
      new Request("http://localhost:3000/api/audit", { headers: { cookie } }),
    );

    expect(readResponse.status).toBe(200);
    expect(mutationResponse.status).toBe(403);
    expect(await mutationResponse.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(auditResponse.status).toBe(403);
  });

  it.each(["operator", "admin", "owner"] as const)(
    "autorise le rôle %s à créer une tâche par héritage",
    async (role) => {
      const email = `${role}@icos.test`;
      await createHuman(role, email);
      const { cookie } = await signIn(email);

      const response = await postTask(
        new Request("http://localhost:3000/api/tasks", {
          method: "POST",
          headers: mutationHeaders(cookie),
          body: JSON.stringify({ title: `Tâche ${role}` }),
        }),
      );

      expect(response.status).toBe(201);
    },
  );

  it("refuse une mutation cross-origin avant de lire le corps", async () => {
    await createHuman("operator", "operator@icos.test");
    const { cookie } = await signIn("operator@icos.test");
    const request = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://attacker.test",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ title: "Ne doit pas être lu" }),
    });
    const readBody = vi.spyOn(request, "json");

    const response = await postTask(request);

    expect(response.status).toBe(403);
    expect(readBody).not.toHaveBeenCalled();
  });

  it("classe une session supprimée comme expirée", async () => {
    await createHuman("viewer", EMAIL);
    const { cookie } = await signIn();
    await ctx.handle.db.delete(sessionTable);

    const response = await getAgents(
      new Request("http://localhost:3000/api/agents", { headers: { cookie } }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "session_expired" } });
  });

  it("classe une session expirée en base comme expirée", async () => {
    await createHuman("viewer", EMAIL);
    const { cookie } = await signIn();
    await ctx.handle.db
      .update(sessionTable)
      .set({ expiresAt: new Date("2000-01-01T00:00:00.000Z") });

    const response = await getAgents(
      new Request("http://localhost:3000/api/agents", { headers: { cookie } }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "session_expired" } });
  });

  it("refuse une requête sans credential avant tout accès métier", async () => {
    const response = await getAgents(new Request("http://localhost:3000/api/agents"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.access.denied",
        actor: { kind: "system", id: "icos-auth" },
        details: expect.objectContaining({ reason: "missing_session" }),
      }),
    ]);
  });

  it("refuse un compte désactivé et révoque sa session", async () => {
    const userId = await createHuman("viewer", EMAIL);
    const { cookie } = await signIn();
    await ctx.handle.db
      .update(userTable)
      .set({ status: "disabled" })
      .where(eq(userTable.id, userId));

    const response = await getAgents(
      new Request("http://localhost:3000/api/agents", { headers: { cookie } }),
    );
    const remaining = await ctx.handle.db
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(eq(sessionTable.userId, userId));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "account_disabled" } });
    expect(remaining).toEqual([]);
  });

  it("refuse la connexion d'un compte désactivé et supprime la session créée", async () => {
    const userId = await createHuman("viewer", EMAIL);
    await ctx.handle.db
      .update(userTable)
      .set({ status: "disabled" })
      .where(eq(userTable.id, userId));

    const response = await postAuth(signInRequest(), authContext("sign-in", "email"));
    const remaining = await ctx.handle.db
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(eq(sessionTable.userId, userId));

    expect(response.status).toBe(403);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.json()).toMatchObject({ error: { code: "account_disabled" } });
    expect(remaining).toEqual([]);
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.login.rejected",
        actor: { kind: "human", id: userId },
        details: { reason: "account_disabled" },
      }),
    ]);
  });

  it("déconnecte, révoque la session et refuse ensuite son cookie", async () => {
    const userId = await createHuman("viewer", EMAIL);
    const { cookie } = await signIn();

    const logout = await postAuth(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: mutationHeaders(cookie),
      }),
      authContext("sign-out"),
    );
    const access = await getAgents(
      new Request("http://localhost:3000/api/agents", { headers: { cookie } }),
    );
    const remaining = await ctx.handle.db
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(eq(sessionTable.userId, userId));

    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await logout.json()).toEqual({ success: true });
    expect(remaining).toEqual([]);
    expect(access.status).toBe(401);
    expect(await access.json()).toMatchObject({ error: { code: "session_expired" } });

    const entries = await container.audit.list();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.logout.succeeded",
          actor: { kind: "human", id: userId },
          details: {},
        }),
        expect.objectContaining({
          eventType: "auth.access.denied",
          details: expect.objectContaining({ reason: "expired_session" }),
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toMatch(/password|cookie|token|secret|hash/i);
  });

  it("garde l'inscription publique hors de l'allowlist", async () => {
    const response = await postAuth(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Intrus" }),
      }),
      authContext("sign-up", "email"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await container.auth?.readHumanUserByEmail(EMAIL)).toBeNull();
  });
});
