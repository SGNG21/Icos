import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { BRAIN_IDS, BRAIN_ROLES, CHIEF_BRAIN_ID } from "@/core/workforce/brains";
import { requiredRoleTests } from "@/core/workforce/role-composer";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

import { seedBrains } from "./brain-seed";
import { grantBrainTools } from "./brain-tool-grants";
import { boundTaskCompute } from "./mission-binding";
import { PostgresWorkforceStore } from "./postgres-workforce-store";
import { bootstrap, certifier, makeService, owner } from "./test-support";

/**
 * DECISION 0070, PROVEN ON POSTGRESQL: goal → Chief → brain assignment → CORE3 task → the
 * dispatch attempt CORE3 persisted carries the brain. The live defect this closes: Chief's
 * assignments named stages (`<mission>:research`) and `forTask` matched task ids
 * (`task-…`), so 10 live assignments influenced 0 dispatches.
 *
 * Local test database only (`ICOS_TEST_DATABASE_URL`); `pnpm test` excludes this file.
 */
process.env.OMNIROUTE_BASE_URL ??= "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??= "bridge-test-key";
process.env.ICOS_REVIEWER_MODEL ??= "bridge-test-model";
process.env.ICOS_REVIEWER_TIMEOUT_MS ??= "1000";

const WORKFORCE_TABLES = sql`TRUNCATE workforce_events, workforce_performance_observations, workforce_assignments, workforce_agents, workforce_departments, workforce_roles, workforce_skills`;

const opened = new Set<Container>();
async function freshProcess(): Promise<Container> {
  const container = await buildPostgresContainer(TEST_DATABASE_URL);
  opened.add(container);
  return container;
}
afterEach(async () => {
  for (const c of opened) await c.close().catch(() => {});
  opened.clear();
});

/** The canonical human acts, through the real service: certify, activate, seed, grant. */
async function seedTwelveBrains(container: Container) {
  await container.db!.execute(WORKFORCE_TABLES);
  const store = new PostgresWorkforceStore(container.db!);
  const { service } = makeService(store);
  await service.seedBootstrap(owner, bootstrap);
  for (const { roleId, version } of BRAIN_ROLES) {
    const role = bootstrap.roles.find((r) => r.roleId === roleId && r.version === version)!;
    await service.certifyRole(
      certifier,
      roleId,
      version,
      requiredRoleTests(role, bootstrap.skills),
    );
    await service.activateRole(owner, roleId, version);
  }
  expect((await seedBrains({ service, store }, owner)).complete).toBe(true);
  expect((await grantBrainTools({ service, store }, owner, BRAIN_IDS)).complete).toBe(true);
}

const goalOf = (id: string, rawInput: string, metadata: Record<string, string>): HighLevelGoal => ({
  id,
  title: rawInput,
  objective: rawInput,
  rawInput,
  normalizedIntent: rawInput,
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "read_only",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata,
  createdAt: new Date().toISOString(),
});

/** Exactly what production composes (`workforceDispatchBridge`), on this container. */
function bridgeFor(container: Container) {
  const workforce = container.workforce!;
  const system = workforce.runtime.system("core3-dispatch");
  const chief = workforce.runtime.actAsAgent(system, CHIEF_BRAIN_ID);
  return boundTaskCompute(workforce.core3Compute, {
    missions: container.mission,
    goals: container.goalRepository,
    chief: workforce.chiefDelegation(chief),
    report: () => {},
  });
}

function supervisorFor(container: Container) {
  vi.spyOn(container.taskExecution, "dispatch").mockImplementation(async (input) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));
  return new SupervisorService(
    container.mission,
    container.tasks,
    container.taskExecution,
    container.durableMemory,
    container.dispatchAttempts,
    undefined,
    undefined,
    undefined,
    bridgeFor(container),
  );
}

async function missionFromGoal(
  container: Container,
  rawInput: string,
  metadata: Record<string, string>,
) {
  const goalId = `g-bridge-${randomUUID().slice(0, 8)}`;
  const goal = goalOf(goalId, rawInput, metadata);
  await container.goalRepository.create(goal, {
    goalId,
    missionTitle: rawInput,
    missionObjective: rawInput,
    tasks: [],
  });
  const mission = await container.mission.create({
    title: rawInput,
    objective: rawInput,
    goalId,
    tasks: [
      {
        title: "Analyse",
        description: "ANALYSE_OK",
        dependsOn: [],
        workerKind: "agent",
        riskClass: "read_only",
      },
      {
        title: "Implémente",
        description: "BUILD_OK",
        dependsOn: [],
        workerKind: "agent",
        capability: "code_write",
      },
    ],
  });
  return { goalId, mission, tasks: await container.mission.listTasks(mission.id) };
}

async function attemptsOf(container: Container, missionId: string) {
  const rows = await container.db!.execute<{
    task_id: string;
    workforce: {
      agentIds: string[];
      assignmentIds: string[];
      complexityFloor: "low" | "medium" | "high";
      complexityRaised: boolean;
    } | null;
  }>(
    sql`select task_id, routing_decision->'workforce' as workforce from dispatch_attempts where mission_id = ${missionId} order by task_id`,
  );
  return [...rows];
}

async function assignmentsOf(container: Container, missionId: string) {
  const rows = await container.db!.execute<{
    task_id: string;
    assignee_agent_id: string;
    status: string;
  }>(
    sql`select task_id, assignee_agent_id, status from workforce_assignments where mission_id = ${missionId} order by task_id, assignee_agent_id`,
  );
  return [...rows];
}

describe("dispatch bridge (decision 0070) — PostgreSQL", () => {
  it("software objective: Planner owns the task, Builder the code_write task, and the attempts say so", async () => {
    const container = await freshProcess();
    await seedTwelveBrains(container);
    const { mission, tasks } = await missionFromGoal(
      container,
      "Ajoute une page de paramètres utilisateur.",
      { "icos.source": "cognitive_conversation" },
    );

    await supervisorFor(container).run(mission.id);

    const byTitle = new Map(tasks.map((t) => [t.title, t.taskId]));
    /* BRAIN_ASSIGNMENT_PERSISTED + CORE3_TASK_BRAIN_LINK: rows carry CORE3 task ids. */
    const byAgent = <T extends { assignee_agent_id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => a.assignee_agent_id.localeCompare(b.assignee_agent_id));
    expect(byAgent(await assignmentsOf(container, mission.id))).toEqual(
      byAgent([
        {
          task_id: `${mission.id}:review`,
          assignee_agent_id: "brain-reviewer",
          status: "assigned",
        },
        {
          task_id: byTitle.get("Analyse")!,
          assignee_agent_id: "brain-planner",
          status: "assigned",
        },
        {
          task_id: byTitle.get("Implémente")!,
          assignee_agent_id: "brain-builder",
          status: "assigned",
        },
      ]),
    );
    /* DISPATCH_USES_BRAIN_ASSIGNMENT: the persisted attempt names the brain that governed it. */
    const attempts = await attemptsOf(container, mission.id);
    const byTask = new Map(attempts.map((a) => [a.task_id, a.workforce]));
    expect(byTask.get(byTitle.get("Analyse")!)).toMatchObject({
      agentIds: ["brain-planner"],
      // A read_only task routes `low` on its own; the Planner's skill floor is above it: RAISED.
      complexityRaised: true,
    });
    const build = byTask.get(byTitle.get("Implémente")!)!;
    expect(build.agentIds).toEqual(["brain-builder"]);
    // A reversible task already routes `medium`: the evidence says whether Builder changed it.
    expect(build.complexityRaised).toBe(build.complexityFloor === "high");
    /* The reviewer is bound too, under its own key — read by the ReviewerService. */
    expect(await container.workforce!.reviewAssignmentFor(mission.id)).toMatchObject({
      agentId: "brain-reviewer",
    });

    /* RETRY_PRESERVES_ASSIGNMENT: another pass of the same process binds nothing new. */
    await supervisorFor(container).run(mission.id);
    expect((await assignmentsOf(container, mission.id)).length).toBe(3);
    /* RESUME_PRESERVES_ASSIGNMENT: a fresh process reads the same durable rows. */
    const resumed = await freshProcess();
    const need = await bridgeFor(resumed).forTask(mission.id, byTitle.get("Analyse")!);
    expect(need?.agentIds).toEqual(["brain-planner"]);
    expect((await assignmentsOf(resumed, mission.id)).length).toBe(3);
  });

  it("self-improvement enters through Evolution; a repair goes to Recovery; a client goes to Business", async () => {
    const container = await freshProcess();
    await seedTwelveBrains(container);
    const cases: [string, Record<string, string>, string][] = [
      ["Améliore ICOS.", {}, "brain-evolution"],
      ["Répare la régression de connexion.", { "icos.domain": "maintenance" }, "brain-recovery"],
      ["Audite le client LDS et propose un plan.", {}, "brain-business"],
    ];
    for (const [rawInput, metadata, lead] of cases) {
      const { mission, tasks } = await missionFromGoal(container, rawInput, metadata);
      await supervisorFor(container).run(mission.id);
      const analyse = tasks.find((t) => t.title === "Analyse")!.taskId;
      const attempt = (await attemptsOf(container, mission.id)).find((a) => a.task_id === analyse);
      expect(attempt?.workforce?.agentIds, rawInput).toEqual([lead]);
    }
  });

  it("a mission with no goal is dispatched exactly as before: no brain, no evidence", async () => {
    const container = await freshProcess();
    await seedTwelveBrains(container);
    const mission = await container.mission.create({
      title: "sans goal",
      objective: "sans goal",
      tasks: [{ title: "A", description: "A_OK", dependsOn: [], workerKind: "agent" }],
    });
    await supervisorFor(container).run(mission.id);
    expect(await assignmentsOf(container, mission.id)).toEqual([]);
    expect((await attemptsOf(container, mission.id)).map((a) => a.workforce)).toEqual([null]);
  });
});
