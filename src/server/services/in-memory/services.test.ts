import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";
import { InMemoryAuditLog, type AuditLog } from "@/server/audit/in-memory-audit-log";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import { InMemoryAgentService } from "./agent-service";
import { InMemoryTaskService } from "./task-service";

/** Journal factice qui échoue systématiquement à l'ajout. */
class FailingAuditLog implements AuditLog {
  append(): AuditEntry {
    throw new Error("écriture d'audit indisponible");
  }
  appendMany(): readonly AuditEntry[] {
    throw new Error("écriture d'audit indisponible");
  }
  list(): readonly AuditEntry[] {
    return [];
  }
  query(): readonly AuditEntry[] {
    return [];
  }
}

describe("InMemoryAgentService", () => {
  it("ne modifie pas les constantes importées et isole ses résultats", () => {
    const service = new InMemoryAgentService(demoAgents);
    const listed = service.list();
    listed[0].name = "corrompu";

    expect(service.list()[0].name).not.toBe("corrompu");
    expect(demoAgents[0].name).not.toBe("corrompu");
  });

  it("retrouve un agent par identifiant", () => {
    const service = new InMemoryAgentService(demoAgents);
    expect(service.getById("agent-cto")?.name).toBe("CTO");
    expect(service.getById("inconnu")).toBeUndefined();
  });
});

describe("InMemoryTaskService", () => {
  it("crée une tâche et écrit l'entrée d'audit correspondante", () => {
    const audit = new InMemoryAuditLog();
    const service = new InMemoryTaskService(audit, demoTasks);

    const result = service.create({ title: "Nouvelle tâche", assignedAgentId: "agent-cto" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(service.getById(result.task.id)?.status).toBe("draft");
    }
    expect(audit.query({ eventType: "task.created" })).toHaveLength(1);
  });

  it("n'applique pas la création si l'audit échoue", () => {
    const service = new InMemoryTaskService(new FailingAuditLog(), demoTasks);
    const before = service.list().length;

    const result = service.create({ title: "Tâche fantôme" });
    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
    expect(service.list()).toHaveLength(before);
  });

  it("applique une transition valide et l'audite", () => {
    const audit = new InMemoryAuditLog();
    const service = new InMemoryTaskService(audit, demoTasks);

    const result = service.transition("task-003", "running");
    expect(result.ok).toBe(true);
    expect(service.getById("task-003")?.status).toBe("running");
    expect(audit.query({ eventType: "task.transitioned", taskId: "task-003" })).toHaveLength(1);
  });

  it("refuse une transition invalide sans écrire d'audit", () => {
    const audit = new InMemoryAuditLog();
    const service = new InMemoryTaskService(audit, demoTasks);

    const result = service.transition("task-001", "running");
    expect(result).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(audit.list()).toHaveLength(0);
  });

  it("n'applique pas la transition si l'audit échoue", () => {
    const service = new InMemoryTaskService(new FailingAuditLog(), demoTasks);
    const result = service.transition("task-003", "running");
    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
    expect(service.getById("task-003")?.status).toBe("queued");
  });

  it("isole ses résultats de lecture", () => {
    const service = new InMemoryTaskService(new InMemoryAuditLog(), demoTasks);
    const listed = service.list();
    listed[0].title = "corrompu";
    expect(service.list()[0].title).not.toBe("corrompu");
  });
});
