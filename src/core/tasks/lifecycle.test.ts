import { describe, expect, it } from "vitest";

import type { Task, TaskStatus } from "@/core/contracts";

import { canTransition, transitionTask } from "./lifecycle";

function makeTask(status: TaskStatus): Task {
  return {
    id: "task-001",
    title: "Tâche de test",
    status,
    actionIds: [],
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
  };
}

describe("transitions valides", () => {
  const valid: Array<[TaskStatus, TaskStatus]> = [
    ["draft", "queued"],
    ["draft", "cancelled"],
    ["queued", "awaiting_approval"],
    ["queued", "running"],
    ["awaiting_approval", "running"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "cancelled"],
  ];

  for (const [from, to] of valid) {
    it(`${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
      const result = transitionTask(makeTask(from), to, "2026-07-21T10:00:00.000Z");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task.status).toBe(to);
        expect(result.task.updatedAt).toBe("2026-07-21T10:00:00.000Z");
      }
    });
  }
});

describe("transitions invalides", () => {
  it("refuse un saut d'état non autorisé sans exception", () => {
    const result = transitionTask(makeTask("draft"), "running");
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_transition",
      from: "draft",
      to: "running",
    });
  });

  it("interdit toute sortie d'un état terminal", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      for (const target of ["draft", "queued", "awaiting_approval", "running"] as const) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it("ne modifie pas la tâche d'origine", () => {
    const task = makeTask("draft");
    transitionTask(task, "queued", "2026-07-21T10:00:00.000Z");
    expect(task.status).toBe("draft");
    expect(task.updatedAt).toBe("2026-07-21T08:00:00.000Z");
  });
});
