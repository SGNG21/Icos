import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";
import { InMemoryAuditLog, type AuditLog } from "@/server/audit/in-memory-audit-log";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import { InMemoryAgentRepository } from "./agent-repository";
import { InMemoryTaskRepository } from "./task-repository";

/** Journal factice qui échoue systématiquement à l'ajout. */
class FailingAuditLog implements AuditLog {
  append(): AuditEntry {
    throw new Error("écriture d'audit indisponible");
  }
  appendMany(): AuditEntry[] {
    throw new Error("écriture d'audit indisponible");
  }
  list(): AuditEntry[] {
    return [];
  }
  query(): AuditEntry[] {
    return [];
  }
}

describe("InMemoryAgentRepository", () => {
  it("ne modifie pas les constantes importées et isole ses résultats", async () => {
    const repo = new InMemoryAgentRepository(demoAgents);
    const listed = await repo.list();
    listed[0].name = "corrompu";

    expect((await repo.list())[0].name).not.toBe("corrompu");
    expect(demoAgents[0].name).not.toBe("corrompu");
  });

  it("retrouve un agent par identifiant, sinon null", async () => {
    const repo = new InMemoryAgentRepository(demoAgents);
    expect((await repo.getById("agent-cto"))?.name).toBe("CTO");
    expect(await repo.getById("inconnu")).toBeNull();
  });

  it("applique la portée aux listes et recherches sans exposer les autres agents", async () => {
    const repo = new InMemoryAgentRepository(demoAgents);
    const linked = { kind: "linked", agentIds: new Set(["agent-cto"]) } as const;

    expect(await repo.listForScope({ kind: "global" })).toEqual(await repo.list());
    expect((await repo.listForScope(linked)).map(({ id }) => id)).toEqual(["agent-cto"]);
    expect(await repo.getByIdForScope("agent-cto", linked)).not.toBeNull();
    expect(await repo.getByIdForScope("agent-ceo", linked)).toBeNull();
    expect(await repo.listForScope({ kind: "linked", agentIds: new Set() })).toEqual([]);
  });
});

describe("InMemoryTaskRepository", () => {
  it("crée une tâche et écrit l'entrée d'audit correspondante", async () => {
    const audit = new InMemoryAuditLog();
    const repo = new InMemoryTaskRepository(audit, demoTasks);

    const result = await repo.create({ title: "Nouvelle tâche", assignedAgentId: "agent-cto" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((await repo.getById(result.task.id))?.status).toBe("draft");
    }
    expect(audit.query({ eventType: "task.created" })).toHaveLength(1);
  });

  it("n'applique pas la création si l'audit échoue", async () => {
    const repo = new InMemoryTaskRepository(new FailingAuditLog(), demoTasks);
    const before = (await repo.list()).length;

    const result = await repo.create({ title: "Tâche fantôme" });
    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
    expect(await repo.list()).toHaveLength(before);
  });

  it("applique une transition valide et l'audite", async () => {
    const audit = new InMemoryAuditLog();
    const repo = new InMemoryTaskRepository(audit, demoTasks);

    const result = await repo.transition("task-003", "running");
    expect(result.ok).toBe(true);
    expect((await repo.getById("task-003"))?.status).toBe("running");
    expect(audit.query({ eventType: "task.transitioned", taskId: "task-003" })).toHaveLength(1);
  });

  it("refuse une transition invalide sans écrire d'audit", async () => {
    const audit = new InMemoryAuditLog();
    const repo = new InMemoryTaskRepository(audit, demoTasks);

    const result = await repo.transition("task-001", "running");
    expect(result).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(audit.list()).toHaveLength(0);
  });

  it("n'applique pas la transition si l'audit échoue", async () => {
    const repo = new InMemoryTaskRepository(new FailingAuditLog(), demoTasks);
    const result = await repo.transition("task-003", "running");
    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
    expect((await repo.getById("task-003"))?.status).toBe("queued");
  });

  it("isole ses résultats de lecture", async () => {
    const repo = new InMemoryTaskRepository(new InMemoryAuditLog(), demoTasks);
    const listed = await repo.list();
    listed[0].title = "corrompu";
    expect((await repo.list())[0].title).not.toBe("corrompu");
  });

  it("rend les tâches non assignées visibles en portée liée et cache les hors portée", async () => {
    const unassigned = {
      ...demoTasks[0],
      id: "task-unassigned",
      assignedAgentId: undefined,
    };
    const repo = new InMemoryTaskRepository(new InMemoryAuditLog(), [...demoTasks, unassigned]);
    const linked = { kind: "linked", agentIds: new Set(["agent-cto"]) } as const;

    expect(await repo.listForScope({ kind: "global" })).toEqual(await repo.list());
    expect((await repo.listForScope(linked)).map(({ id }) => id)).toEqual([
      "task-001",
      "task-unassigned",
    ]);
    expect(await repo.getByIdForScope("task-001", linked)).not.toBeNull();
    expect(await repo.getByIdForScope("task-002", linked)).toBeNull();
    expect(await repo.getByIdForScope("task-unassigned", linked)).not.toBeNull();
    expect(
      (await repo.listForScope({ kind: "linked", agentIds: new Set() })).map(({ id }) => id),
    ).toEqual(["task-unassigned"]);
  });
});
