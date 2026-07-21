import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAgentService } from "@/server/services/in-memory/agent-service";
import { InMemoryTaskService } from "@/server/services/in-memory/task-service";
import { demoAgents } from "@/features/agents/data";

import { createTask } from "./create-task";

function deps() {
  return {
    tasks: new InMemoryTaskService(new InMemoryAuditLog(), []),
    agents: new InMemoryAgentService(demoAgents),
  };
}

describe("createTask", () => {
  it("crée une tâche non assignée", () => {
    const result = createTask(deps(), { title: "Tâche libre" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.assignedAgentId).toBeUndefined();
      expect(result.task.status).toBe("draft");
    }
  });

  it("crée une tâche assignée à un agent existant", () => {
    const result = createTask(deps(), { title: "Tâche assignée", assignedAgentId: "agent-cto" });
    expect(result.ok).toBe(true);
  });

  it("refuse une tâche assignée à un agent inexistant, sans mutation", () => {
    const d = deps();
    const result = createTask(d, { title: "Tâche", assignedAgentId: "agent-fantome" });
    expect(result).toMatchObject({ ok: false, reason: "agent_not_found" });
    expect(d.tasks.list()).toHaveLength(0);
  });
});
