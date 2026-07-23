import { describe, expect, it, vi } from "vitest";

import { demoActions } from "@/features/actions/data";
import type { Database } from "@/server/database/client";
import type { IcosBetterAuth } from "@/server/auth/better-auth";
import type { AuthGateway, RoleRepository } from "@/server/auth/ports";
import type {
  AgentRepository,
  AuditRepository,
  HumanAgentLinkRepository,
  HumanUserAdministrationRepository,
} from "@/server/repositories/ports";
import type { HumanAdministrationUnitOfWork } from "@/server/uow/ports";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import { buildMemoryContainer, composeAdministration, composeAuthentication } from "./container";

const unusedDatabase = {} as Database;
const unusedRoles = {} as RoleRepository;

describe("buildMemoryContainer", () => {
  it("compose le container avec les seeds cohérents par défaut", async () => {
    const container = buildMemoryContainer();
    expect((await container.agents.list()).length).toBe(demoAgents.length);
    expect((await container.actions.list({ approvalStatus: "pending" })).length).toBeGreaterThan(0);
  });

  it("ne compose aucune capacité PostgreSQL avec le backend mémoire", () => {
    const container = buildMemoryContainer();

    expect(container.auth).toBeUndefined();
    expect(container.authHttp).toBeUndefined();
    expect(container.users).toBeUndefined();
    expect(container.agentLinks).toBeUndefined();
    expect(container.humanAdministration).toBeUndefined();
    expect(container.operationalAccess).toBeUndefined();
    expect(container.humanAdministrationUow).toBeUndefined();
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

describe("composeAdministration", () => {
  const users = {} as HumanUserAdministrationRepository;
  const agentLinks = {} as HumanAgentLinkRepository;
  const agents = {} as AgentRepository;
  const audit = {} as AuditRepository;
  const humanAdministrationUow = {} as HumanAdministrationUnitOfWork;

  it("partage les mêmes collaborateurs PostgreSQL et la même façade auth", () => {
    const auth = {} as AuthGateway;
    const composed = composeAdministration({
      auth,
      users,
      agentLinks,
      agents,
      audit,
      humanAdministrationUow,
    });

    expect(composed.users).toBe(users);
    expect(composed.agentLinks).toBe(agentLinks);
    expect(composed.humanAdministrationUow).toBe(humanAdministrationUow);
    expect(composed.operationalAccess).toMatchObject({ links: agentLinks });
    expect(composed.humanAdministration).toMatchObject({
      auth,
      users,
      links: agentLinks,
      agents,
      audit,
      uow: humanAdministrationUow,
    });
  });

  it("ne compose pas le service administratif sans auth", () => {
    const composed = composeAdministration({
      users,
      agentLinks,
      agents,
      audit,
      humanAdministrationUow,
    });

    expect(composed.humanAdministration).toBeUndefined();
    expect(composed.operationalAccess).toBeDefined();
  });
});
