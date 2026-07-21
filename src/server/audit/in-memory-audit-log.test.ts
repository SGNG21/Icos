import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";

import { InMemoryAuditLog } from "./in-memory-audit-log";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "audit-001",
    occurredAt: "2026-07-21T09:00:00.000Z",
    eventType: "task.created",
    actor: { kind: "system", id: "icos" },
    taskId: "task-001",
    details: { title: "Tâche" },
    ...overrides,
  };
}

describe("InMemoryAuditLog", () => {
  it("expose uniquement des opérations de lecture et d'ajout (append-only)", () => {
    const log = new InMemoryAuditLog();
    const publicApi = Object.getOwnPropertyNames(Object.getPrototypeOf(log));
    expect(publicApi.sort()).toEqual(
      ["append", "appendMany", "constructor", "list", "query"].sort(),
    );
    expect(publicApi).not.toContain("delete");
    expect(publicApi).not.toContain("update");
    expect(publicApi).not.toContain("clear");
  });

  it("conserve les entrées ajoutées dans l'ordre", () => {
    const log = new InMemoryAuditLog();
    log.append(makeEntry({ id: "audit-001" }));
    log.append(makeEntry({ id: "audit-002", eventType: "task.transitioned" }));
    expect(log.list().map((entry) => entry.id)).toEqual(["audit-001", "audit-002"]);
  });

  it("valide l'entrée et rejette une entrée invalide", () => {
    const log = new InMemoryAuditLog();
    expect(() => log.append(makeEntry({ occurredAt: "hier" }))).toThrow();
    expect(log.list()).toHaveLength(0);
  });

  it("empêche la modification de l'état interne via les valeurs retournées", () => {
    const log = new InMemoryAuditLog();
    log.append(makeEntry());

    const returned = log.append(makeEntry({ id: "audit-002" }));
    (returned.details as Record<string, unknown>).title = "corrompu";

    const listed = log.list();
    listed[0].details.title = "corrompu-aussi";

    expect(log.list()[1].details.title).toBe("Tâche");
    expect(log.list()[0].details.title).toBe("Tâche");
  });

  it("filtre les entrées par type, acteur, tâche et action", () => {
    const log = new InMemoryAuditLog();
    log.append(makeEntry({ id: "audit-001", eventType: "task.created", taskId: "task-001" }));
    log.append(
      makeEntry({
        id: "audit-002",
        eventType: "approval.recorded",
        actor: { kind: "human", id: "geoffrey" },
        taskId: undefined,
        actionId: "action-001",
        details: { decision: "approved" },
      }),
    );

    expect(log.query({ eventType: "task.created" }).map((e) => e.id)).toEqual(["audit-001"]);
    expect(log.query({ actorId: "geoffrey" }).map((e) => e.id)).toEqual(["audit-002"]);
    expect(log.query({ taskId: "task-001" }).map((e) => e.id)).toEqual(["audit-001"]);
    expect(log.query({ actionId: "action-001" }).map((e) => e.id)).toEqual(["audit-002"]);
    expect(log.query({ eventType: "task.created", actorId: "geoffrey" })).toHaveLength(0);
  });
});
