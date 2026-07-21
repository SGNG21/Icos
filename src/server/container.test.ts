import { describe, expect, it } from "vitest";

import { demoActions } from "@/features/actions/data";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import { buildMemoryContainer } from "./container";

describe("buildMemoryContainer", () => {
  it("compose le container avec les seeds cohérents par défaut", async () => {
    const container = buildMemoryContainer();
    expect((await container.agents.list()).length).toBe(demoAgents.length);
    expect((await container.actions.list({ approvalStatus: "pending" })).length).toBeGreaterThan(0);
  });

  it("échoue explicitement si une action référence une tâche qui ne la liste pas", () => {
    expect(() =>
      buildMemoryContainer({
        agents: demoAgents,
        tasks: demoTasks.map((task) =>
          task.id === "task-002" ? { ...task, actionIds: [] } : task,
        ),
        actions: demoActions,
      }),
    ).toThrow(/intégrité seed/);
  });

  it("échoue si une action est initiée par un agent inexistant", () => {
    expect(() =>
      buildMemoryContainer({
        agents: demoAgents,
        tasks: demoTasks,
        actions: demoActions.map((action) =>
          action.id === "action-001" ? { ...action, initiatedByAgentId: "agent-fantome" } : action,
        ),
      }),
    ).toThrow(/intégrité seed/);
  });
});
