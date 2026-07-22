import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Agent, AgentAction, Task } from "@/core/contracts";
import { actionToRow, agentToRow, taskToRow } from "@/server/database/mappers";
import { actions, agents, tasks } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { GET as getTasks, POST as postTask } from "@/app/api/tasks/route";
import { POST as postTransition } from "@/app/api/tasks/[id]/transition/route";
import { POST as postDecision } from "@/app/api/actions/[id]/decision/route";
import { GET as getAudit } from "@/app/api/audit/route";

import { buildMemoryContainer, getContainer, resetContainer } from "./container";

const savedPersistence = process.env.PERSISTENCE;
const savedUrl = process.env.DATABASE_URL;
const ISO = "2026-07-22T10:00:00.000Z";

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const agent = (id: string, level: 0 | 1 | 2 | 3): Agent => ({
  id,
  name: id,
  role: "r",
  status: "available",
  authorizationLevel: level,
  description: "d",
});

const task = (id: string): Task => ({
  id,
  title: id,
  status: "awaiting_approval",
  actionIds: [id.replace("task", "action")],
  createdAt: ISO,
  updatedAt: ISO,
});

const action = (id: string, taskId: string, agentId: string): AgentAction => ({
  id,
  initiatedByAgentId: agentId,
  kind: "repository.push",
  risk: "sensitive",
  requiresHumanApproval: true,
  approvalStatus: "pending",
  taskId,
  requestedAt: ISO,
});

describe.skipIf(!dockerAvailable)("Container PostgreSQL + routes (intégration)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
    process.env.PERSISTENCE = "postgres";
    process.env.DATABASE_URL = ctx.container.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await resetContainer();
    if (savedPersistence === undefined) delete process.env.PERSISTENCE;
    else process.env.PERSISTENCE = savedPersistence;
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
    await ctx.handle.db.insert(agents).values([agentToRow(agent("agent-op", 2))]);
  });

  it("le container postgres lit les agents", async () => {
    const container = await getContainer();
    expect((await container.agents.list())[0]?.id).toBe("agent-op");
  });

  it("route POST /api/tasks crée une tâche persistée", async () => {
    const response = await postTask(
      jsonRequest("http://localhost/api/tasks", { title: "Nouvelle" }),
    );
    expect(response.status).toBe(201);
    const list = await getTasks();
    const data = (await list.json()) as { tasks: { title: string }[] };
    expect(data.tasks.map((t) => t.title)).toContain("Nouvelle");
  });

  it("route POST /api/tasks/[id]/transition applique la transition", async () => {
    await ctx.handle.db.insert(tasks).values(taskToRow({ ...task("task-t"), actionIds: [] }));
    const response = await postTransition(
      jsonRequest("http://localhost/api/tasks/task-t/transition", { to: "running" }),
      params("task-t"),
    );
    expect(response.status).toBe(200);
  });

  it("route POST /api/actions/[id]/decision décide atomiquement (allowed)", async () => {
    await ctx.handle.db.insert(tasks).values(taskToRow(task("task-d")));
    await ctx.handle.db
      .insert(actions)
      .values(actionToRow(action("action-d", "task-d", "agent-op")));

    const response = await postDecision(
      jsonRequest("http://localhost/api/actions/action-d/decision", {
        decidedByLabel: "Opérateur (simulé)",
        decision: "approved",
      }),
      params("action-d"),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { execution: { outcome: string } };
    expect(data.execution.outcome).toBe("allowed");

    // Audit chronologique via la route.
    const audit = await getAudit(new Request("http://localhost/api/audit?actionId=action-d"));
    const auditData = (await audit.json()) as { entries: { occurredAt: string }[] };
    expect(auditData.entries.length).toBeGreaterThanOrEqual(2);
  });

  it("parité de tri agents : memory et postgres renvoient le même ordre", async () => {
    // Jeu d'agents varié (niveaux mixtes) inséré en base.
    const seed = [agent("agent-b", 1), agent("agent-a", 3), agent("agent-c", 3)];
    await truncateAll(ctx.handle);
    await ctx.handle.db.insert(agents).values(seed.map(agentToRow));

    const pg = await getContainer();
    const mem = buildMemoryContainer({ agents: seed, tasks: [], actions: [] });

    const pgOrder = (await pg.agents.list()).map((a) => a.id);
    const memOrder = (await mem.agents.list()).map((a) => a.id);
    // authorizationLevel DESC, id ASC → agent-a, agent-c, agent-b
    expect(pgOrder).toEqual(["agent-a", "agent-c", "agent-b"]);
    expect(memOrder).toEqual(pgOrder);
    await mem.close();
  });
});
