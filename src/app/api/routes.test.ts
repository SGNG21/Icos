import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

import { GET as getActions } from "./actions/route";
import { POST as postDecision } from "./actions/[id]/decision/route";
import { GET as getAgents } from "./agents/route";
import { GET as getAudit } from "./audit/route";
import { GET as getTasks, POST as postTask } from "./tasks/route";
import { POST as postTransition } from "./tasks/[id]/transition/route";

const CONTAINER_KEY = "__icosContainerPromise__";
const APP_ORIGIN = "http://localhost";
const SESSION_COOKIE = "icos.session_token=opaque-test-value";

function authenticatedSession(
  role: Role,
  status: "active" | "disabled" = "active",
): AuthenticatedSession {
  return {
    user: {
      id: "human-1",
      email: "human@icos.test",
      name: "Human",
      status,
    },
    roles: [role],
  };
}

function authGateway(session: AuthenticatedSession | null): AuthGateway {
  return {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
}

function installSession(session: AuthenticatedSession | null): Container {
  const base = buildMemoryContainer();
  const container: Container = {
    ...base,
    auth: authGateway(session),
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

function installRole(role: Role): Container {
  return installSession(authenticatedSession(role));
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
});

function getRequest(path: string, authenticated = true): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    headers: authenticated ? { cookie: SESSION_COOKIE } : undefined,
  });
}

function jsonRequest(
  path: string,
  body: unknown,
  options: { origin?: string; roleCookie?: boolean } = {},
): Request {
  const origin = options.origin ?? APP_ORIGIN;
  const authenticated = options.roleCookie ?? true;
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": origin === APP_ORIGIN ? "same-origin" : "cross-site",
      ...(authenticated ? { cookie: SESSION_COOKIE } : {}),
    },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function errorCode(response: Response): Promise<string | undefined> {
  const data = (await response.json()) as { error?: { code?: string } };
  return data.error?.code;
}

describe("matrice d'autorisation HTTP", () => {
  it("autorise viewer à lire les agents", async () => {
    installRole("viewer");

    const response = await getAgents(getRequest("/api/agents"));

    expect(response.status).toBe(200);
  });

  it("autorise viewer à lire les tâches", async () => {
    installRole("viewer");

    const response = await getTasks(getRequest("/api/tasks"));

    expect(response.status).toBe(200);
  });

  it("réserve la création de tâche à operator+", async () => {
    installRole("viewer");
    const denied = await postTask(jsonRequest("/api/tasks", { title: "Interdit" }));

    installRole("operator");
    const allowed = await postTask(jsonRequest("/api/tasks", { title: "Autorisé" }));

    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("forbidden");
    expect(allowed.status).toBe(201);
  });

  it("réserve les transitions de tâche à operator+", async () => {
    installRole("viewer");
    const denied = await postTransition(
      jsonRequest("/api/tasks/task-003/transition", { to: "running" }),
      params("task-003"),
    );

    installRole("operator");
    const allowed = await postTransition(
      jsonRequest("/api/tasks/task-003/transition", { to: "running" }),
      params("task-003"),
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it("autorise viewer à lire les actions", async () => {
    installRole("viewer");

    const response = await getActions(getRequest("/api/actions?approvalStatus=pending"));

    expect(response.status).toBe(200);
  });

  it("réserve les décisions d'approbation à operator+", async () => {
    const command = {
      decidedByLabel: "Opérateur",
      decision: "approved",
    };
    installRole("viewer");
    const denied = await postDecision(
      jsonRequest("/api/actions/action-001/decision", command),
      params("action-001"),
    );

    installRole("operator");
    const allowed = await postDecision(
      jsonRequest("/api/actions/action-001/decision", command),
      params("action-001"),
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it("réserve la lecture complète de l'audit à operator+", async () => {
    installRole("viewer");
    const denied = await getAudit(getRequest("/api/audit"));

    installRole("operator");
    const allowed = await getAudit(getRequest("/api/audit"));

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });
});

describe("refus de sécurité HTTP", () => {
  it("refuse un credential absent sans lire le repository", async () => {
    const container = installRole("viewer");
    const list = vi.spyOn(container.agents, "list");

    const response = await getAgents(getRequest("/api/agents", false));

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthenticated");
    expect(list).not.toHaveBeenCalled();
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.access.denied",
        actor: { kind: "system", id: "icos-auth" },
        details: expect.objectContaining({
          method: "GET",
          route: "api.agents",
          permission: "cockpit.read",
          reason: "missing_session",
        }),
      }),
    ]);
  });

  it("classe un credential sans session comme expiré", async () => {
    const container = installSession(null);

    const response = await getTasks(getRequest("/api/tasks"));

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("session_expired");
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ reason: "expired_session" }),
      }),
    ]);
  });

  it("refuse et attribue au compte humain désactivé son audit", async () => {
    const container = installSession(authenticatedSession("owner", "disabled"));

    const response = await getTasks(getRequest("/api/tasks"));

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("account_disabled");
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        actor: { kind: "human", id: "human-1" },
        details: expect.objectContaining({ reason: "account_disabled" }),
      }),
    ]);
  });

  it("audite un refus de permission sans donnée sensible", async () => {
    const container = installRole("viewer");

    const response = await postTask(jsonRequest("/api/tasks", { title: "Interdit" }));

    expect(response.status).toBe(403);
    const entries = await container.audit.list();
    expect(entries).toEqual([
      expect.objectContaining({
        eventType: "auth.access.denied",
        actor: { kind: "human", id: "human-1" },
        details: {
          method: "POST",
          route: "api.tasks",
          permission: "tasks.write",
          reason: "forbidden",
        },
      }),
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/password|cookie|token|secret|hash|headers/i);
  });

  it("refuse une mutation cross-origin avant toute lecture du corps", async () => {
    const container = installRole("operator");
    const crossOrigin = jsonRequest(
      "/api/tasks",
      { title: "Ne doit pas être lu" },
      { origin: "https://attacker.test" },
    );
    const readBody = vi.spyOn(crossOrigin, "json");

    const response = await postTask(crossOrigin);

    expect(response.status).toBe(403);
    expect(readBody).not.toHaveBeenCalled();
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        actor: { kind: "human", id: "human-1" },
        details: {
          method: "POST",
          route: "api.tasks",
          permission: "tasks.write",
          reason: "cross_origin",
        },
      }),
    ]);
  });
});

describe("GET /api/agents", () => {
  it("liste les agents et interdit le cache", async () => {
    installRole("viewer");

    const response = await getAgents(getRequest("/api/agents"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const data = (await response.json()) as { agents: unknown[] };
    expect(data.agents.length).toBeGreaterThan(0);
  });
});

describe("POST /api/tasks", () => {
  it("crée une tâche valide (201)", async () => {
    installRole("operator");

    const response = await postTask(jsonRequest("/api/tasks", { title: "Test" }));

    expect(response.status).toBe(201);
    const data = (await response.json()) as { task: { status: string } };
    expect(data.task.status).toBe("draft");
  });

  it("rejette un titre vide après trim (400)", async () => {
    installRole("operator");

    const response = await postTask(jsonRequest("/api/tasks", { title: "   " }));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("rejette un agent assigné inexistant (422)", async () => {
    installRole("operator");

    const response = await postTask(
      jsonRequest("/api/tasks", { title: "Test", assignedAgentId: "agent-x" }),
    );

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("agent_not_found");
  });
});

describe("POST /api/tasks/[id]/transition", () => {
  it("applique une transition valide (200)", async () => {
    installRole("operator");

    const response = await postTransition(
      jsonRequest("/api/tasks/task-003/transition", { to: "running" }),
      params("task-003"),
    );

    expect(response.status).toBe(200);
  });

  it("refuse une transition invalide (409)", async () => {
    installRole("operator");

    const response = await postTransition(
      jsonRequest("/api/tasks/task-001/transition", { to: "running" }),
      params("task-001"),
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("invalid_transition");
  });

  it("répond 404 pour une tâche inconnue", async () => {
    installRole("operator");

    const response = await postTransition(
      jsonRequest("/api/tasks/task-999/transition", { to: "running" }),
      params("task-999"),
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /api/actions", () => {
  it("liste les actions en attente", async () => {
    installRole("viewer");

    const response = await getActions(getRequest("/api/actions?approvalStatus=pending"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { actions: unknown[] };
    expect(data.actions.length).toBeGreaterThan(0);
  });
});

describe("POST /api/actions/[id]/decision", () => {
  it("approuve une action et retourne une décision d'exécution, sans exécution réelle", async () => {
    installRole("operator");

    const response = await postDecision(
      jsonRequest("/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur (simulé)",
        decision: "approved",
      }),
      params("action-001"),
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      approval: { decidedBy: string };
      execution: { outcome: string };
      executed?: unknown;
    };
    expect(data.executed).toBeUndefined();
    expect(["allowed", "awaiting_approval", "refused"]).toContain(data.execution.outcome);
    expect(data.approval.decidedBy).toBe("Opérateur (simulé)");
  });

  it("refuse un rejet sans motif (400)", async () => {
    installRole("operator");

    const response = await postDecision(
      jsonRequest("/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "rejected",
      }),
      params("action-001"),
    );

    expect(response.status).toBe(400);
  });

  it("rejette un champ superflu injecté (400)", async () => {
    installRole("operator");

    const response = await postDecision(
      jsonRequest("/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
        authorizationLevel: 3,
      }),
      params("action-001"),
    );

    expect(response.status).toBe(400);
  });

  it("répond 404 pour une action inconnue", async () => {
    installRole("operator");

    const response = await postDecision(
      jsonRequest("/api/actions/action-999/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
      }),
      params("action-999"),
    );

    expect(response.status).toBe(404);
  });

  it("refuse une seconde décision sur la même action (409)", async () => {
    installRole("operator");
    const command = {
      decidedByLabel: "Opérateur",
      decision: "approved",
    };
    await postDecision(
      jsonRequest("/api/actions/action-001/decision", command),
      params("action-001"),
    );

    const response = await postDecision(
      jsonRequest("/api/actions/action-001/decision", command),
      params("action-001"),
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("already_decided");
  });
});

describe("GET /api/audit", () => {
  it("reflète l'audit d'une décision et filtre par type", async () => {
    installRole("operator");
    await postDecision(
      jsonRequest("/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
      }),
      params("action-001"),
    );

    const response = await getAudit(
      getRequest("/api/audit?eventType=approval.recorded&actionId=action-001"),
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { entries: unknown[] };
    expect(data.entries).toHaveLength(1);
  });
});
