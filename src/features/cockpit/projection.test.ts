import { describe, expect, it } from "vitest";

import type { Agent, Task, TaskExecutionResult } from "@/core/contracts";

import { buildCockpitProjection, summarize } from "./projection";

const agent: Agent = {
  id: "agent-cto",
  name: "CTO",
  role: "Directeur technique",
  status: "available",
  authorizationLevel: 2,
  description: "Agent de test",
};

function task(overrides: Partial<Task> & Pick<Task, "id" | "status">): Task {
  return {
    title: `Tâche ${overrides.id}`,
    actionIds: [],
    createdAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  } as Task;
}

function execution(overrides: Partial<TaskExecutionResult> & Pick<TaskExecutionResult, "taskId">) {
  return {
    id: `texec-${overrides.taskId}`,
    workflowId: `icos-task-${overrides.taskId}`,
    outcome: "success",
    completedAt: "2026-08-18T11:00:00.000Z",
    recordedAt: "2026-08-18T11:00:01.000Z",
    ...overrides,
  } as TaskExecutionResult;
}

describe("buildCockpitProjection", () => {
  it("classe le travail actif, l'attention requise et les résultats récents", () => {
    const projection = buildCockpitProjection({
      tasks: [
        task({ id: "task-running", status: "running", updatedAt: "2026-08-18T12:00:00.000Z" }),
        task({ id: "task-queued", status: "queued", updatedAt: "2026-08-18T11:00:00.000Z" }),
        task({ id: "task-failed", status: "failed", updatedAt: "2026-08-18T13:00:00.000Z" }),
        task({ id: "task-ok", status: "succeeded", updatedAt: "2026-08-18T09:00:00.000Z" }),
      ],
      agents: [agent],
      executions: [
        execution({ taskId: "task-ok", result: "Analyse terminée" }),
        execution({
          taskId: "task-failed",
          outcome: "failure",
          error: { code: "WORKER_FAILED", message: "modèle indisponible" },
        }),
      ],
    });

    expect(projection.activeWork.map((p) => p.task.id)).toEqual(["task-running", "task-queued"]);
    expect(projection.attentionRequired.map((p) => p.task.id)).toEqual(["task-failed"]);
    expect(projection.recentResults.map((p) => p.task.id)).toEqual(["task-failed", "task-ok"]);
    expect(projection.counts.running).toBe(1);
    expect(projection.counts.failed).toBe(1);
  });

  it("expose un résumé lisible du résultat ou de l'erreur", () => {
    const projection = buildCockpitProjection({
      tasks: [
        task({ id: "task-ok", status: "succeeded" }),
        task({ id: "task-ko", status: "failed" }),
      ],
      agents: [],
      executions: [
        execution({ taskId: "task-ok", result: "ICOS_TEMPORAL_HERMES_OK" }),
        execution({
          taskId: "task-ko",
          outcome: "failure",
          error: { code: "WORKER_TIMEOUT", message: "délai dépassé" },
        }),
      ],
    });

    const ok = projection.recentResults.find((p) => p.task.id === "task-ok");
    const ko = projection.recentResults.find((p) => p.task.id === "task-ko");
    expect(ok?.summary).toBe("ICOS_TEMPORAL_HERMES_OK");
    expect(ko?.summary).toBe("délai dépassé");
  });

  it("résout le nom de l'agent assigné, sans inventer de valeur", () => {
    const projection = buildCockpitProjection({
      tasks: [
        task({ id: "task-a", status: "running", assignedAgentId: "agent-cto" }),
        task({ id: "task-b", status: "running" }),
      ],
      agents: [agent],
      executions: [],
    });

    expect(projection.activeWork.find((p) => p.task.id === "task-a")?.agentName).toBe("CTO");
    expect(projection.activeWork.find((p) => p.task.id === "task-b")?.agentName).toBeNull();
  });
});

describe("summarize", () => {
  it("laisse un texte court intact et tronque un texte long", () => {
    expect(summarize("court")).toBe("court");
    const long = "a".repeat(200);
    expect(summarize(long).length).toBeLessThanOrEqual(160);
    expect(summarize(long).endsWith("…")).toBe(true);
  });

  it("normalise les espaces", () => {
    expect(summarize("ligne1\n\n  ligne2")).toBe("ligne1 ligne2");
  });
});
