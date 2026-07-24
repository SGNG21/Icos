import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { HumanAdministrationService } from "@/server/administration/human-administration-service";
import type { AuthGateway } from "@/server/auth/ports";
import type { HumanAgentLinkRepository } from "@/server/repositories/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

import { GET as getAdminAgents } from "./admin/agents/route";
import { GET as getActions } from "./actions/route";
import { GET as getAgentLinks, POST as postAgentLink } from "./users/[id]/agent-links/route";
import { DELETE as deleteAgentLink } from "./users/[id]/agent-links/[agentId]/route";
import { PATCH as patchUserRole } from "./users/[id]/role/route";
import { PATCH as patchUserStatus } from "./users/[id]/status/route";
import { GET as getUsers, POST as postUser } from "./users/route";
import { POST as postDecision } from "./actions/[id]/decision/route";
import { GET as getAgents } from "./agents/route";
import { GET as getAudit } from "./audit/route";
import { GET as getTasks, POST as postTask } from "./tasks/route";
import { POST as postTransition } from "./tasks/[id]/transition/route";
import { GET as getCapabilities, POST as postCapability } from "./capabilities/route";
import { PATCH as patchCapabilityStatus } from "./capabilities/[id]/status/route";
import {
  GET as getAgentCapabilities,
  POST as postAgentCapability,
} from "./agents/[id]/capabilities/route";
import { DELETE as deleteAgentCapability } from "./agents/[id]/capabilities/[capabilityId]/route";

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

/** Installation par défaut avec l'administration mockée retournant un service fonctionnel. */
function installAdminRole(role: Role): Container & { mockAdmin: HumanAdministrationService } {
  const mockAdmin: HumanAdministrationService = {
    listUsers: async () => [],
    createHuman: async () => ({
      ok: true,
      value: {
        id: "new-id",
        email: "created@icos.test",
        name: "Created",
        status: "active",
        role: "viewer",
      },
      changed: true,
    }),
    replaceRole: async () => ({
      ok: true,
      value: {
        id: "target",
        email: "target@icos.test",
        name: "Target",
        status: "active",
        role: "admin",
      },
      changed: true,
    }),
    setStatus: async () => ({
      ok: true,
      value: {
        id: "target",
        email: "target@icos.test",
        name: "Target",
        status: "disabled",
        role: "viewer",
      },
      changed: true,
    }),
    listLinks: async () => ({ ok: true, value: [], changed: false }),
    createLink: async () => ({
      ok: true,
      value: {
        id: "link-new",
        humanUserId: "target",
        agentId: "agent-001",
        relation: "operator",
        createdAt: new Date().toISOString(),
        createdByHumanUserId: "human-1",
      },
      changed: true,
    }),
    removeLink: async () => ({
      ok: true,
      value: {
        id: "link-001",
        humanUserId: "target",
        agentId: "agent-001",
        relation: "observer",
        createdAt: new Date().toISOString(),
        createdByHumanUserId: "human-1",
      },
      changed: true,
    }),
    authorizedTarget: async () => ({
      ok: true,
      target: {
        id: "target",
        email: "target@icos.test",
        name: "Target",
        status: "active",
        role: "viewer",
      },
    }),
    runMutation: async () => ({ ok: true, value: {} as never, changed: true }),
    deny: async () => ({
      ok: false,
      reason: "forbidden",
      message: "opération administrative refusée",
    }),
    compensate: async () => ({
      ok: false,
      reason: "internal_error",
      message: "administration humaine indisponible",
    }),
  } as unknown as HumanAdministrationService;

  const base = buildMemoryContainer();
  const container: Container = {
    ...base,
    auth: authGateway(authenticatedSession(role)),
    humanAdministration: mockAdmin,
    operationalAccess: undefined,
    users: undefined,
    agentLinks: undefined,
    humanAdministrationUow: undefined,
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return { ...container, mockAdmin };
}

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

function agentLinkParams(id: string, agentId: string) {
  return { params: Promise.resolve({ id, agentId }) };
}

async function errorCode(response: Response): Promise<string | undefined> {
  const data = (await response.json()) as { error?: { code?: string } };
  return data.error?.code;
}

function installScopedRole(role: Role, linkedAgentIds: string[]): Container {
  const container = installRole(role);
  const mockLinks: HumanAgentLinkRepository = {
    listForHuman: async () => [],
    listAgentIdsForHuman: async () => new Set(linkedAgentIds),
  };
  container.operationalAccess = new OperationalAccessService(mockLinks);
  return container;
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

describe("matrice de refus container mémoire", () => {
  it("retourne persistence_unavailable si l'administration n'est pas montée", async () => {
    installRole("admin");
    const responses = await Promise.all([
      getUsers(getRequest("/api/users")),
      postUser(
        jsonRequest("/api/users", {
          email: "new@icos.test",
          password: "correct horse battery staple",
          role: "viewer",
        }),
      ),
      patchUserRole(jsonRequest("/api/users/human-2/role", { role: "admin" }), params("human-2")),
      patchUserStatus(
        jsonRequest("/api/users/human-2/status", { status: "disabled" }),
        params("human-2"),
      ),
      getAgentLinks(getRequest("/api/users/human-2/agent-links"), params("human-2")),
      postAgentLink(
        jsonRequest("/api/users/human-2/agent-links", {
          agentId: "agent-001",
          relation: "operator",
        }),
        params("human-2"),
      ),
      deleteAgentLink(
        jsonRequest("/api/users/human-2/agent-links/agent-001", {}),
        agentLinkParams("human-2", "agent-001"),
      ),
      getAdminAgents(getRequest("/api/admin/agents")),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe("persistence_unavailable");
    }
  });
});

describe("GET /api/users", () => {
  it("refuse viewer à lire les utilisateurs", async () => {
    installAdminRole("viewer");
    const response = await getUsers(getRequest("/api/users"));

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("autorise admin à lire les utilisateurs", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "listUsers").mockResolvedValue([
      { id: "human-1", email: "admin@icos.test", name: "Admin", status: "active", role: "owner" },
    ]);

    const response = await getUsers(getRequest("/api/users"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { users: unknown[] };
    expect(data.users).toHaveLength(1);
  });

  it("refuse sans session", async () => {
    installAdminRole("admin");
    const response = await getUsers(getRequest("/api/users", false));

    expect(response.status).toBe(401);
  });

  it("audite sans exposer de secret", async () => {
    const container = installAdminRole("admin");
    await getUsers(getRequest("/api/users"));

    const entries = await container.audit.list();
    expect(JSON.stringify(entries)).not.toMatch(/cookie|token|secret|password|hash|headers/i);
  });
});

describe("POST /api/users", () => {
  it("refuse viewer à créer un utilisateur", async () => {
    installAdminRole("viewer");
    const response = await postUser(
      jsonRequest("/api/users", {
        email: "new@icos.test",
        password: "correct horse battery staple",
        name: "New",
        role: "viewer",
      }),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("refuse un corps supplémentaire", async () => {
    installAdminRole("admin");
    const response = await postUser(
      jsonRequest("/api/users", {
        email: "new@icos.test",
        password: "correct horse battery staple",
        role: "viewer",
        injected: true,
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("refuse un mot de passe trop court", async () => {
    installAdminRole("admin");
    const response = await postUser(
      jsonRequest("/api/users", {
        email: "new@icos.test",
        password: "short",
        role: "viewer",
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("refuse un email invalide", async () => {
    installAdminRole("admin");
    const response = await postUser(
      jsonRequest("/api/users", {
        email: "invalid",
        password: "correct horse battery staple",
        role: "viewer",
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("répond 201 sur création valide et audite", async () => {
    const { mockAdmin } = installAdminRole("admin");
    const createSpy = vi.spyOn(mockAdmin, "createHuman").mockResolvedValue({
      ok: true,
      value: {
        id: "created-id",
        email: "new@icos.test",
        name: "New",
        status: "active",
        role: "viewer",
      },
      changed: true,
    });

    const response = await postUser(
      jsonRequest("/api/users", {
        email: "new@icos.test",
        password: "correct horse battery staple",
        name: "New",
        role: "viewer",
      }),
    );

    expect(response.status).toBe(201);
    expect(createSpy).toHaveBeenCalled();
    const data = (await response.json()) as { user: { id?: string } };
    expect(data.user?.id).toBe("created-id");
  });

  it("mappe déjà existant en 409 sans révéler l'origine", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "createHuman").mockResolvedValue({
      ok: false,
      reason: "already_exists",
      message: "doublon",
    });

    const response = await postUser(
      jsonRequest("/api/users", {
        email: "duplicate@icos.test",
        password: "correct horse battery staple",
        role: "viewer",
      }),
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("already_exists");
  });

  it("refuse cross-origin avant lecture du corps", async () => {
    const { mockAdmin } = installAdminRole("admin");
    const call = vi.spyOn(mockAdmin, "createHuman");
    const response = await postUser(
      jsonRequest(
        "/api/users",
        { email: "new@icos.test", password: "correct horse battery staple", role: "viewer" },
        { origin: "https://evil.test" },
      ),
    );

    expect(response.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/users/[id]/role", () => {
  it("refuse owner à s'auto-modifier", async () => {
    installAdminRole("owner");
    const response = await patchUserRole(
      jsonRequest("/api/users/human-1/role", { role: "admin" }),
      params("human-1"),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("refuse cross-origin avant lecture du corps", async () => {
    const { mockAdmin } = installAdminRole("admin");
    const call = vi.spyOn(mockAdmin, "replaceRole");
    const request = jsonRequest(
      "/api/users/human-2/role",
      { role: "viewer" },
      { origin: "https://evil.test" },
    );

    const response = await patchUserRole(request, params("human-2"));

    expect(response.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("valide et exécute une mutation rôle valide", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "replaceRole").mockResolvedValue({
      ok: true,
      value: {
        id: "human-2",
        email: "target@icos.test",
        name: "Target",
        status: "active",
        role: "admin",
      },
      changed: true,
    });

    const response = await patchUserRole(
      jsonRequest("/api/users/human-2/role", { role: "admin" }),
      params("human-2"),
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { user: { role?: string } };
    expect(data.user?.role).toBe("admin");
  });

  it("rejette un rôle invalide", async () => {
    installAdminRole("admin");
    const response = await patchUserRole(
      jsonRequest("/api/users/human-2/role", { role: "superadmin" }),
      params("human-2"),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("rejette 409 last_owner", async () => {
    const { mockAdmin } = installAdminRole("owner");
    vi.spyOn(mockAdmin, "replaceRole").mockResolvedValue({
      ok: false,
      reason: "last_owner",
      message: "refusé",
    });

    const response = await patchUserRole(
      jsonRequest("/api/users/human-2/role", { role: "viewer" }),
      params("human-2"),
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("last_owner");
  });

  it("rejette 404 si la cible est absente", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "replaceRole").mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "cible inconnue",
    });

    const response = await patchUserRole(
      jsonRequest("/api/users/human-x/role", { role: "viewer" }),
      params("human-x"),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("rejette 403 si l'acteur est insuffisant", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "replaceRole").mockResolvedValue({
      ok: false,
      reason: "forbidden",
      message: "refusé",
    });

    const response = await patchUserRole(
      jsonRequest("/api/users/human-2/role", { role: "viewer" }),
      params("human-2"),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("ne révèle pas de secret", async () => {
    const container = installAdminRole("admin");
    await patchUserRole(
      jsonRequest("/api/users/human-2/role", { role: "admin" }),
      params("human-2"),
    );

    expect(JSON.stringify(await container.audit.list())).not.toMatch(
      /cookie|token|secret|password|hash|headers/i,
    );
  });
});

describe("PATCH /api/users/[id]/status", () => {
  it("refuse viewer à mettre à jour un statut", async () => {
    installAdminRole("viewer");
    const response = await patchUserStatus(
      jsonRequest("/api/users/human-2/status", { status: "disabled" }),
      params("human-2"),
    );

    expect(response.status).toBe(403);
  });

  it("refuse auto-désactivation", async () => {
    installAdminRole("admin");
    const response = await patchUserStatus(
      jsonRequest("/api/users/human-1/status", { status: "disabled" }),
      params("human-1"),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("valide et exécute une mutation statut", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "setStatus").mockResolvedValue({
      ok: true,
      value: {
        id: "human-2",
        email: "target@icos.test",
        name: "Target",
        status: "disabled",
        role: "viewer",
      },
      changed: true,
    });

    const response = await patchUserStatus(
      jsonRequest("/api/users/human-2/status", { status: "disabled" }),
      params("human-2"),
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { user: { status?: string } };
    expect(data.user?.status).toBe("disabled");
  });

  it("rejette un statut invalide", async () => {
    installAdminRole("admin");
    const response = await patchUserStatus(
      jsonRequest("/api/users/human-2/status", { status: "archived" }),
      params("human-2"),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("rejette 404 si la cible est absente", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "setStatus").mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "cible inconnue",
    });

    const response = await patchUserStatus(
      jsonRequest("/api/users/human-x/status", { status: "disabled" }),
      params("human-x"),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("rejette 409 si c'est le dernier owner", async () => {
    const { mockAdmin } = installAdminRole("owner");
    vi.spyOn(mockAdmin, "setStatus").mockResolvedValue({
      ok: false,
      reason: "last_owner",
      message: "refusé",
    });

    const response = await patchUserStatus(
      jsonRequest("/api/users/human-2/status", { status: "disabled" }),
      params("human-2"),
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("last_owner");
  });

  it("refuse cross-origin avant validation", async () => {
    const { mockAdmin } = installAdminRole("admin");
    const call = vi.spyOn(mockAdmin, "setStatus");
    const response = await patchUserStatus(
      jsonRequest(
        "/api/users/human-2/status",
        { status: "disabled" },
        { origin: "https://evil.test" },
      ),
      params("human-2"),
    );

    expect(response.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("GET /api/users/[id]/agent-links", () => {
  it("refuse viewer", async () => {
    installAdminRole("viewer");
    const response = await getAgentLinks(
      getRequest("/api/users/human-2/agent-links"),
      params("human-2"),
    );

    expect(response.status).toBe(403);
  });

  it("répond 404 si l'administration signale une cible absente", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "listLinks").mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "cible absente",
    });

    const response = await getAgentLinks(
      getRequest("/api/users/human-x/agent-links"),
      params("human-x"),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("autorise admin à lire des liens", async () => {
    installAdminRole("admin");
    const response = await getAgentLinks(
      getRequest("/api/users/human-2/agent-links"),
      params("human-2"),
    );

    expect(response.status).toBe(200);
  });
});

describe("POST /api/users/[id]/agent-links", () => {
  it("refuse cross-origin", async () => {
    const { mockAdmin } = installAdminRole("admin");
    const call = vi.spyOn(mockAdmin, "createLink");
    const response = await postAgentLink(
      jsonRequest(
        "/api/users/human-2/agent-links",
        { agentId: "agent-001", relation: "operator" },
        { origin: "https://attacker.test" },
      ),
      params("human-2"),
    );

    expect(response.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("valide un lien et retourne 201", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "createLink").mockResolvedValue({
      ok: true,
      value: {
        id: "link-001",
        humanUserId: "human-2",
        agentId: "agent-001",
        relation: "operator",
        createdAt: new Date().toISOString(),
        createdByHumanUserId: "human-1",
      },
      changed: true,
    });

    const response = await postAgentLink(
      jsonRequest("/api/users/human-2/agent-links", { agentId: "agent-001", relation: "operator" }),
      params("human-2"),
    );

    expect(response.status).toBe(201);
  });

  it("rejette un agent inconnu (404)", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "createLink").mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "agent absent",
    });

    const response = await postAgentLink(
      jsonRequest("/api/users/human-2/agent-links", { agentId: "agent-x", relation: "operator" }),
      params("human-2"),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("rejette une relation inconnue (400)", async () => {
    installAdminRole("admin");
    const response = await postAgentLink(
      jsonRequest("/api/users/human-2/agent-links", { agentId: "agent-001", relation: "manager" }),
      params("human-2"),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("refuse viewer", async () => {
    installAdminRole("viewer");
    const response = await postAgentLink(
      jsonRequest("/api/users/human-2/agent-links", { agentId: "agent-001", relation: "operator" }),
      params("human-2"),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("mappe déjà existant en 409", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "createLink").mockResolvedValue({
      ok: false,
      reason: "already_exists",
      message: "doublon",
    });

    const response = await postAgentLink(
      jsonRequest("/api/users/human-2/agent-links", { agentId: "agent-001", relation: "operator" }),
      params("human-2"),
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("already_exists");
  });

  it("ne révèle pas de secret dans les audits", async () => {
    const container = installAdminRole("admin");
    await postAgentLink(
      jsonRequest("/api/users/human-2/agent-links", { agentId: "agent-001", relation: "operator" }),
      params("human-2"),
    );

    expect(JSON.stringify(await container.audit.list())).not.toMatch(
      /cookie|token|secret|password|hash|headers/i,
    );
  });
});

describe("DELETE /api/users/[id]/agent-links/[agentId]", () => {
  it("refuse auto-suppression", async () => {
    installAdminRole("admin");
    const response = await deleteAgentLink(
      jsonRequest("/api/users/human-1/agent-links/agent-001", {}),
      agentLinkParams("human-1", "agent-001"),
    );

    expect(response.status).toBe(403);
  });

  it("refuse si la paire est absente (404)", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "removeLink").mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "lien absent",
    });

    const response = await deleteAgentLink(
      jsonRequest("/api/users/human-2/agent-links/agent-x", {}),
      agentLinkParams("human-2", "agent-x"),
    );

    expect(response.status).toBe(404);
  });

  it("supprime une paire valide et retourne 204", async () => {
    const { mockAdmin } = installAdminRole("admin");
    vi.spyOn(mockAdmin, "removeLink").mockResolvedValue({
      ok: true,
      value: {
        id: "link-001",
        humanUserId: "human-2",
        agentId: "agent-001",
        relation: "observer",
        createdAt: new Date().toISOString(),
        createdByHumanUserId: "human-1",
      },
      changed: true,
    });

    const response = await deleteAgentLink(
      jsonRequest("/api/users/human-2/agent-links/agent-001", {}),
      agentLinkParams("human-2", "agent-001"),
    );

    expect(response.status).toBe(204);
  });

  it("refuse viewer", async () => {
    installAdminRole("viewer");
    const response = await deleteAgentLink(
      jsonRequest("/api/users/human-2/agent-links/agent-001", {}),
      agentLinkParams("human-2", "agent-001"),
    );

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("refuse cross-origin", async () => {
    const { mockAdmin } = installAdminRole("admin");
    const call = vi.spyOn(mockAdmin, "removeLink");
    const response = await deleteAgentLink(
      jsonRequest("/api/users/human-2/agent-links/agent-001", {}, { origin: "https://evil.test" }),
      agentLinkParams("human-2", "agent-001"),
    );

    expect(response.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("refuse si le dernier owner tente une suppression", async () => {
    const { mockAdmin } = installAdminRole("owner");
    vi.spyOn(mockAdmin, "removeLink").mockResolvedValue({
      ok: false,
      reason: "last_owner",
      message: "refusé",
    });

    const response = await deleteAgentLink(
      jsonRequest("/api/users/human-2/agent-links/agent-001", {}),
      agentLinkParams("human-2", "agent-001"),
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("last_owner");
  });

  it("ne révèle pas de secret", async () => {
    const container = installAdminRole("admin");
    await deleteAgentLink(
      jsonRequest("/api/users/human-2/agent-links/agent-001", {}),
      agentLinkParams("human-2", "agent-001"),
    );

    expect(JSON.stringify(await container.audit.list())).not.toMatch(
      /cookie|token|secret|password|hash|headers/i,
    );
  });
});

describe("GET /api/admin/agents", () => {
  it("refuse operator", async () => {
    installAdminRole("operator");
    const response = await getAdminAgents(getRequest("/api/admin/agents"));

    expect(response.status).toBe(403);
  });

  it("retourne la liste globale pour admin", async () => {
    installAdminRole("admin");
    const response = await getAdminAgents(getRequest("/api/admin/agents"));

    expect(response.status).toBe(200);
  });

  it("ne filtre pas les agents par rattachement", async () => {
    installAdminRole("admin");
    const response = await getAdminAgents(getRequest("/api/admin/agents"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { agents: unknown[] };
    expect(data.agents.length).toBeGreaterThan(0);
  });
});

describe("portée opérationnelle liée", () => {
  it("limite la liste des agents à la portée de l'opérateur", async () => {
    installScopedRole("operator", ["agent-cto"]);

    const response = await getAgents(getRequest("/api/agents"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { agents: { id: string }[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].id).toBe("agent-cto");
  });

  it("retourne une liste vide pour un opérateur sans rattachement", async () => {
    installScopedRole("operator", []);

    const response = await getAgents(getRequest("/api/agents"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { agents: unknown[] };
    expect(data.agents).toHaveLength(0);
  });

  it("offre une portée globale à admin", async () => {
    installScopedRole("admin", []);

    const response = await getAgents(getRequest("/api/agents"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { agents: unknown[] };
    expect(data.agents.length).toBeGreaterThan(2);
  });

  it("limite les tâches visibles à la portée de l'opérateur", async () => {
    installScopedRole("operator", ["agent-cto"]);

    const response = await getTasks(getRequest("/api/tasks"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { tasks: { assignedAgentId?: string }[] };
    for (const task of data.tasks) {
      expect(task.assignedAgentId).toBe("agent-cto");
    }
  });

  it("retourne une liste vide de tâches pour un opérateur sans lien", async () => {
    installScopedRole("operator", []);

    const response = await getTasks(getRequest("/api/tasks"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { tasks: unknown[] };
    expect(data.tasks).toHaveLength(0);
  });

  it("limite les actions visibles à la portée de l'opérateur", async () => {
    installScopedRole("operator", ["agent-development"]);

    const response = await getActions(getRequest("/api/actions"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { actions: { initiatedByAgentId?: string }[] };
    expect(data.actions.length).toBeGreaterThan(0);
    for (const action of data.actions) {
      expect(action.initiatedByAgentId).toBe("agent-development");
    }
  });

  it("offre une portée globale à owner pour les actions", async () => {
    installScopedRole("owner", []);

    const response = await getActions(getRequest("/api/actions"));

    expect(response.status).toBe(200);
    const data = (await response.json()) as { actions: unknown[] };
    expect(data.actions.length).toBeGreaterThan(2);
  });

  it("refuse la création de tâche hors portée pour operator", async () => {
    installScopedRole("operator", ["agent-frontend"]);

    const response = await postTask(
      jsonRequest("/api/tasks", { title: "Test", assignedAgentId: "agent-cto" }),
    );

    expect(response.status).toBe(403);
  });

  it("refuse la transition d'une tâche hors portée (404)", async () => {
    installScopedRole("operator", ["agent-frontend"]);

    const response = await postTransition(
      jsonRequest("/api/tasks/task-001/transition", { to: "draft" }),
      params("task-001"),
    );

    expect(response.status).toBe(404);
  });

  it("refuse une décision sur une action hors portée (404)", async () => {
    installScopedRole("operator", ["agent-frontend"]);

    const response = await postDecision(
      jsonRequest("/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
      }),
      params("action-001"),
    );

    expect(response.status).toBe(404);
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

describe("GET /api/capabilities", () => {
  it("autorise viewer", async () => {
    installRole("viewer");
    const response = await getCapabilities(getRequest("/api/capabilities"));
    expect(response.status).toBe(200);
  });

  it("retourne une liste pour admin", async () => {
    installRole("admin");
    const response = await getCapabilities(getRequest("/api/capabilities"));
    expect(response.status).toBe(200);
    const data = (await response.json()) as { capabilities: unknown[] };
    expect(Array.isArray(data.capabilities)).toBe(true);
  });

  it("refuse sans session", async () => {
    installRole("admin");
    const response = await getCapabilities(getRequest("/api/capabilities", false));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/capabilities", () => {
  it("refuse viewer", async () => {
    installRole("viewer");
    const response = await postCapability(
      jsonRequest("/api/capabilities", {
        key: "code.review",
        name: "Code Review",
        category: "code",
      }),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("autorise admin à créer une capacité", async () => {
    installRole("admin");
    const response = await postCapability(
      jsonRequest("/api/capabilities", {
        key: "code.review",
        name: "Code Review",
        category: "code",
      }),
    );
    expect(response.status).toBe(201);
  });

  it("rejette un key invalide", async () => {
    installRole("admin");
    const response = await postCapability(
      jsonRequest("/api/capabilities", {
        key: "Invalid Key!",
        name: "Invalid",
        category: "test",
      }),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("refuse cross-origin", async () => {
    installRole("admin");
    const response = await postCapability(
      jsonRequest(
        "/api/capabilities",
        { key: "test.key", name: "Test", category: "code" },
        { origin: "https://evil.test" },
      ),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });
});

describe("PATCH /api/capabilities/[id]/status", () => {
  function statusRequest(id: string, body: unknown, origin?: string): Request {
    return jsonRequest(`/api/capabilities/${id}/status`, body, origin ? { origin } : undefined);
  }

  function statusParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("refuse viewer", async () => {
    installRole("viewer");
    const response = await patchCapabilityStatus(
      statusRequest("cap-001", { status: "active" }),
      statusParams("cap-001"),
    );
    expect(response.status).toBe(403);
  });

  it("refuse un statut invalide", async () => {
    installRole("admin");
    const response = await patchCapabilityStatus(
      statusRequest("cap-001", { status: "invalid" }),
      statusParams("cap-001"),
    );
    expect(response.status).toBe(400);
  });

  it("refuse cross-origin", async () => {
    installRole("admin");
    const response = await patchCapabilityStatus(
      statusRequest("cap-001", { status: "active" }, "https://evil.test"),
      statusParams("cap-001"),
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /api/agents/[id]/capabilities", () => {
  it("autorise viewer", async () => {
    installRole("viewer");
    const response = await getAgentCapabilities(
      getRequest("/api/agents/agent-cto/capabilities"),
      params("agent-cto"),
    );
    expect(response.status).toBe(200);
  });

  it("refuse sans session", async () => {
    installRole("admin");
    const response = await getAgentCapabilities(
      getRequest("/api/agents/agent-cto/capabilities", false),
      params("agent-cto"),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/agents/[id]/capabilities", () => {
  it("refuse viewer", async () => {
    installRole("viewer");
    const response = await postAgentCapability(
      jsonRequest("/api/agents/agent-cto/capabilities", { capabilityId: "cap-001" }),
      params("agent-cto"),
    );
    expect(response.status).toBe(403);
  });

  it("refuse operator", async () => {
    installRole("operator");
    const response = await postAgentCapability(
      jsonRequest("/api/agents/agent-cto/capabilities", { capabilityId: "cap-001" }),
      params("agent-cto"),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("refuse cross-origin", async () => {
    installRole("admin");
    const response = await postAgentCapability(
      jsonRequest(
        "/api/agents/agent-cto/capabilities",
        { capabilityId: "cap-001" },
        { origin: "https://evil.test" },
      ),
      params("agent-cto"),
    );
    expect(response.status).toBe(403);
  });
});

describe("DELETE /api/agents/[id]/capabilities/[capabilityId]", () => {
  it("refuse viewer", async () => {
    installRole("viewer");
    const response = await deleteAgentCapability(
      jsonRequest("/api/agents/agent-cto/capabilities/ac-001", {}),
      { params: Promise.resolve({ id: "agent-cto", capabilityId: "ac-001" }) },
    );
    expect(response.status).toBe(403);
  });

  it("refuse operator", async () => {
    installRole("operator");
    const response = await deleteAgentCapability(
      jsonRequest("/api/agents/agent-cto/capabilities/ac-001", {}),
      { params: Promise.resolve({ id: "agent-cto", capabilityId: "ac-001" }) },
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("refuse cross-origin", async () => {
    installRole("admin");
    const response = await deleteAgentCapability(
      jsonRequest("/api/agents/agent-cto/capabilities/ac-001", {}, { origin: "https://evil.test" }),
      { params: Promise.resolve({ id: "agent-cto", capabilityId: "ac-001" }) },
    );
    expect(response.status).toBe(403);
  });
});
