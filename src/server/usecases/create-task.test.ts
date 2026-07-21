import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAgentRepository } from "@/server/services/in-memory/agent-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { demoAgents } from "@/features/agents/data";

import { createTask } from "./create-task";

function deps() {
  return {
    tasks: new InMemoryTaskRepository(new InMemoryAuditLog(), []),
    agents: new InMemoryAgentRepository(demoAgents),
  };
}

describe("createTask", () => {
  it("crée une tâche non assignée", async () => {
    const result = await createTask(deps(), { title: "Tâche libre" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.assignedAgentId).toBeUndefined();
      expect(result.task.status).toBe("draft");
    }
  });

  it("crée une tâche assignée à un agent existant", async () => {
    const result = await createTask(deps(), {
      title: "Tâche assignée",
      assignedAgentId: "agent-cto",
    });
    expect(result.ok).toBe(true);
  });

  it("refuse une tâche assignée à un agent inexistant, sans mutation", async () => {
    const d = deps();
    const result = await createTask(d, { title: "Tâche", assignedAgentId: "agent-fantome" });
    expect(result).toMatchObject({ ok: false, reason: "agent_not_found" });
    expect(await d.tasks.list()).toHaveLength(0);
  });
});
