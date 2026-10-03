import { hasDispatchBackstop } from "@/server/control/runtime-control";
import { InMemoryTaskExecutionDispatcher } from "@/server/execution/in-memory-task-execution-dispatcher";
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
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { InMemoryQualityControlRepository } from "@/server/services/in-memory/quality-control-repository";
import { InMemoryAutonomousMissionRuntimeRepository } from "@/server/services/in-memory/autonomous-mission-runtime-repository";
import { InMemoryDurableMemory } from "@/core/context/durable-memory";

const unusedDatabase = {} as Database;
const unusedRoles = {} as RoleRepository;

describe("buildMemoryContainer", () => {
  it("compose le container avec les seeds cohérents par défaut", async () => {
    const container = buildMemoryContainer();
    expect((await container.agents.list()).length).toBe(demoAgents.length);
    expect((await container.actions.list({ approvalStatus: "pending" })).length).toBeGreaterThan(0);
  });

  it("reconstruit le graphe de services ICOS sur des collaborateurs partagés", async () => {
    const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });

    expect(container.taskExecution).toBeInstanceOf(InMemoryTaskExecutionDispatcher);
    // Decision 0044: the runtime dispatcher carries the control backstop.
    expect(hasDispatchBackstop(container.taskExecution)).toBe(true);
    expect(container.control?.guard).toBeDefined();
    expect(container.dispatchAttempts).toBeInstanceOf(InMemoryDispatchAttemptRepository);
    expect(container.executionResults).toBeDefined();
    expect(container.durableMemory).toBeDefined();
    expect(container.reviewer).toBeDefined();
    expect(container.reviewDecisions).toBeDefined();
    expect(container.qualityControlJobs).toBeDefined();
    expect(container.autonomousRuntime).toBeDefined();
    expect(container.conversationService).toBeDefined();
    expect(container.ceoService).toBeDefined();
    expect(container.db).toBeUndefined();
    expect(container.executionCallbackSecret).toBeUndefined();
    expect(container.mission).toBeInstanceOf(InMemoryMissionRepository);
    expect(container.tasks).toBeInstanceOf(InMemoryTaskRepository);
    expect(container.audit).toBeInstanceOf(InMemoryAuditRepository);
    expect(container.dispatchAttempts).toBeInstanceOf(InMemoryDispatchAttemptRepository);
    expect(container.executionResults).toBeInstanceOf(InMemoryTaskExecutionResultRepository);
    expect(container.reviewDecisions).toBeInstanceOf(InMemoryReviewDecisionRepository);
    expect(container.qualityControlJobs).toBeInstanceOf(InMemoryQualityControlRepository);
    expect(container.autonomousRuntime).toBeInstanceOf(InMemoryAutonomousMissionRuntimeRepository);
    expect(container.durableMemory).toBeInstanceOf(InMemoryDurableMemory);

    const mission = await container.mission.create({
      title: "Shared task repository",
      objective: "Prove canonical task sharing",
      tasks: [{ title: "Recover", dependsOn: [] }],
    });
    const [missionTask] = await container.mission.listTasks(mission.id);

    expect(await container.tasks.getById(missionTask.taskId)).not.toBeNull();
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
        trustedOrigins: ["https://icos.test"],
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
