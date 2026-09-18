import { describe, expect, it } from "vitest";

import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAgentRepository } from "@/server/services/in-memory/agent-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { demoAgents } from "@/features/agents/data";

import { createAndDispatchTask } from "./create-and-dispatch-task";

function deps(dispatcher: TaskExecutionDispatcher) {
  const tasks = new InMemoryTaskRepository(new InMemoryAuditLog(), []);
  return {
    tasks,
    agents: new InMemoryAgentRepository(demoAgents),
    taskExecution: dispatcher,
  };
}

const okDispatcher: TaskExecutionDispatcher = {
  async dispatch({ taskId }) {
    return { workflowId: `icos-task-${taskId}` };
  },
};

const failingDispatcher: TaskExecutionDispatcher = {
  async dispatch() {
    throw new Error("temporal indisponible");
  },
};

describe("createAndDispatchTask", () => {
  it("crée la tâche, la dispatche et la place en queued", async () => {
    const d = deps(okDispatcher);
    const result = await createAndDispatchTask(d, { title: "Analyse marché" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("queued");
    expect(result.workflowId).toBe(`icos-task-${result.task.id}`);
    expect((await d.tasks.getById(result.task.id))?.status).toBe("queued");
  });

  it("corrèle workflowId et taskId de façon déterministe", async () => {
    const d = deps(okDispatcher);
    const result = await createAndDispatchTask(d, { title: "Corrélation" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflowId.endsWith(result.task.id)).toBe(true);
  });

  it("laisse la tâche en draft si le dispatch échoue", async () => {
    const d = deps(failingDispatcher);
    const result = await createAndDispatchTask(d, { title: "Sans moteur" });

    expect(result).toMatchObject({ ok: false, reason: "dispatch_failed" });
    const persisted = await d.tasks.list();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("draft");
  });

  it("refuse un agent inexistant sans rien dispatcher", async () => {
    let dispatched = false;
    const spy: TaskExecutionDispatcher = {
      async dispatch({ taskId }) {
        dispatched = true;
        return { workflowId: taskId };
      },
    };
    const d = deps(spy);
    const result = await createAndDispatchTask(d, {
      title: "Tâche",
      assignedAgentId: "agent-fantome",
    });

    expect(result).toMatchObject({ ok: false, reason: "agent_not_found" });
    expect(dispatched).toBe(false);
    expect(await d.tasks.list()).toHaveLength(0);
  });
});
