import { describe, expect, it, vi } from "vitest";

import { demoActions } from "@/features/actions/data";
import type { Database } from "@/server/database/client";
import type { IcosBetterAuth } from "@/server/auth/better-auth";
import type { RoleRepository } from "@/server/auth/ports";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import { buildMemoryContainer, composeAuthentication } from "./container";

const unusedDatabase = {} as Database;
const unusedRoles = {} as RoleRepository;

describe("buildMemoryContainer", () => {
  it("compose le container avec les seeds cohérents par défaut", async () => {
    const container = buildMemoryContainer();
    expect((await container.agents.list()).length).toBe(demoAgents.length);
    expect((await container.actions.list({ approvalStatus: "pending" })).length).toBeGreaterThan(0);
  });

  it("ne compose aucune façade d'authentification avec le backend mémoire", () => {
    const container = buildMemoryContainer();

    expect(container.auth).toBeUndefined();
    expect(container.authHttp).toBeUndefined();
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

describe("composeAuthentication", () => {
  it("compose les deux façades sur l'unique instance Better Auth", () => {
    const betterAuth = { api: {} } as unknown as IcosBetterAuth;
    const createAuth = vi.fn(() => betterAuth);

    const composed = composeAuthentication(
      unusedDatabase,
      unusedRoles,
      {
        secret: "x".repeat(40),
        baseURL: "https://icos.test",
      },
      createAuth,
    );

    expect(createAuth).toHaveBeenCalledTimes(1);
    expect(composed.auth).toBeDefined();
    expect(composed.authHttp).toBeDefined();
  });
});
