import { beforeEach, describe, expect, it } from "vitest";

import { GET as getAgents } from "./agents/route";
import { GET as getTasks, POST as postTask } from "./tasks/route";
import { POST as postTransition } from "./tasks/[id]/transition/route";
import { GET as getActions } from "./actions/route";
import { POST as postDecision } from "./actions/[id]/decision/route";
import { GET as getAudit } from "./audit/route";

const CONTAINER_KEY = "__icosContainer__";

beforeEach(() => {
  // Réinitialise le singleton mémoire : chaque test repart des seeds de démo.
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/agents", () => {
  it("liste les agents et interdit le cache", async () => {
    const response = getAgents();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const data = (await response.json()) as { agents: unknown[] };
    expect(data.agents.length).toBeGreaterThan(0);
  });
});

describe("POST /api/tasks", () => {
  it("crée une tâche valide (201)", async () => {
    const response = await postTask(jsonRequest("http://localhost/api/tasks", { title: "Test" }));
    expect(response.status).toBe(201);
    const data = (await response.json()) as { task: { status: string } };
    expect(data.task.status).toBe("draft");
  });

  it("rejette un titre vide après trim (400)", async () => {
    const response = await postTask(jsonRequest("http://localhost/api/tasks", { title: "   " }));
    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("invalid_input");
  });

  it("rejette un agent assigné inexistant (422)", async () => {
    const response = await postTask(
      jsonRequest("http://localhost/api/tasks", { title: "Test", assignedAgentId: "agent-x" }),
    );
    expect(response.status).toBe(422);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("agent_not_found");
  });
});

describe("POST /api/tasks/[id]/transition", () => {
  it("applique une transition valide (200)", async () => {
    const response = await postTransition(
      jsonRequest("http://localhost/api/tasks/task-003/transition", { to: "running" }),
      params("task-003"),
    );
    expect(response.status).toBe(200);
  });

  it("refuse une transition invalide (409)", async () => {
    const response = await postTransition(
      jsonRequest("http://localhost/api/tasks/task-001/transition", { to: "running" }),
      params("task-001"),
    );
    expect(response.status).toBe(409);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("invalid_transition");
  });

  it("répond 404 pour une tâche inconnue", async () => {
    const response = await postTransition(
      jsonRequest("http://localhost/api/tasks/task-999/transition", { to: "running" }),
      params("task-999"),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/actions", () => {
  it("liste les actions en attente", async () => {
    const response = getActions(new Request("http://localhost/api/actions?approvalStatus=pending"));
    expect(response.status).toBe(200);
    const data = (await response.json()) as { actions: unknown[] };
    expect(data.actions.length).toBeGreaterThan(0);
  });
});

describe("POST /api/actions/[id]/decision", () => {
  it("approuve une action et retourne une décision d'exécution, sans exécution réelle", async () => {
    const response = await postDecision(
      jsonRequest("http://localhost/api/actions/action-001/decision", {
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
    // Aucune notion d'exécution réelle n'est exposée.
    expect(data.executed).toBeUndefined();
    expect(["allowed", "awaiting_approval", "refused"]).toContain(data.execution.outcome);
    // L'étiquette du décideur est déclarative, reprise telle quelle.
    expect(data.approval.decidedBy).toBe("Opérateur (simulé)");
  });

  it("refuse un rejet sans motif (400)", async () => {
    const response = await postDecision(
      jsonRequest("http://localhost/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "rejected",
      }),
      params("action-001"),
    );
    expect(response.status).toBe(400);
  });

  it("rejette un champ superflu injecté (400)", async () => {
    const response = await postDecision(
      jsonRequest("http://localhost/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
        authorizationLevel: 3,
      }),
      params("action-001"),
    );
    expect(response.status).toBe(400);
  });

  it("répond 404 pour une action inconnue", async () => {
    const response = await postDecision(
      jsonRequest("http://localhost/api/actions/action-999/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
      }),
      params("action-999"),
    );
    expect(response.status).toBe(404);
  });

  it("refuse une seconde décision sur la même action (409)", async () => {
    await postDecision(
      jsonRequest("http://localhost/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
      }),
      params("action-001"),
    );
    const response = await postDecision(
      jsonRequest("http://localhost/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
      }),
      params("action-001"),
    );
    expect(response.status).toBe(409);
    const data = (await response.json()) as { error: { code: string } };
    expect(data.error.code).toBe("already_decided");
  });
});

describe("GET /api/audit", () => {
  it("reflète l'audit d'une décision et filtre par type", async () => {
    await postDecision(
      jsonRequest("http://localhost/api/actions/action-001/decision", {
        decidedByLabel: "Opérateur",
        decision: "approved",
      }),
      params("action-001"),
    );

    const response = getAudit(
      new Request("http://localhost/api/audit?eventType=approval.recorded&actionId=action-001"),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { entries: unknown[] };
    expect(data.entries).toHaveLength(1);
  });
});

describe("GET /api/tasks", () => {
  it("liste les tâches", async () => {
    const response = getTasks();
    expect(response.status).toBe(200);
    const data = (await response.json()) as { tasks: unknown[] };
    expect(data.tasks.length).toBeGreaterThan(0);
  });
});
