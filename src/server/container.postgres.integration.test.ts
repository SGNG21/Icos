import { splitSetCookieHeader } from "better-auth/cookies";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Agent, AgentAction, Task } from "@/core/contracts";
import { loadEnv } from "@/config/env";
import { actionToRow, agentToRow, taskToRow } from "@/server/database/mappers";
import { actions, agents, tasks } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { POST as postAuth } from "@/app/api/auth/[...all]/route";
import { GET as getTasks, POST as postTask } from "@/app/api/tasks/route";
import { POST as postTransition } from "@/app/api/tasks/[id]/transition/route";
import { POST as postDecision } from "@/app/api/actions/[id]/decision/route";
import { GET as getAudit } from "@/app/api/audit/route";

import {
  buildMemoryContainer,
  createContainer,
  getContainer,
  resetContainer,
  type Container,
} from "./container";

const ISO = "2026-07-22T10:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const CONTAINER_KEY = "__icosContainerPromise__";

function jsonRequest(url: string, body: unknown, cookie: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: new URL(url).origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function authContext(...all: string[]) {
  return { params: Promise.resolve({ all }) };
}

function requestCookie(response: Response): string {
  const cookie = splitSetCookieHeader(response.headers.get("set-cookie") ?? "")
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("cookie de session absent");
  return cookie;
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
  let container: Container;
  let cookie: string;

  beforeAll(async () => {
    ctx = await startPostgres();
    container = await createContainer({
      env: loadEnv({
        PERSISTENCE: "postgres",
        DATABASE_URL: ctx.container.getConnectionUri(),
        BETTER_AUTH_SECRET: "x".repeat(40),
        BETTER_AUTH_URL: "http://localhost",
      }),
    });
    (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  }, 120_000);

  afterAll(async () => {
    await resetContainer();
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
    await ctx.handle.db.insert(agents).values([agentToRow(agent("agent-op", 2))]);
    if (!container.auth || !container.roles) throw new Error("auth non composée");
    const created = await container.auth.createHumanUser({
      email: "operator@icos.test",
      password: PASSWORD,
    });
    if (!created.ok) throw new Error("création humaine refusée");
    await container.roles.grantRole(created.userId, "operator");
    const response = await postAuth(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ email: "operator@icos.test", password: PASSWORD }),
      }),
      authContext("sign-in", "email"),
    );
    cookie = requestCookie(response);
  });

  it("le container postgres lit les agents", async () => {
    expect((await container.agents.list())[0]?.id).toBe("agent-op");
  });

  it("route POST /api/tasks crée une tâche persistée", async () => {
    const response = await postTask(
      jsonRequest("http://localhost/api/tasks", { title: "Nouvelle" }, cookie),
    );
    expect(response.status).toBe(201);
    const list = await getTasks(new Request("http://localhost/api/tasks", { headers: { cookie } }));
    const data = (await list.json()) as { tasks: { title: string }[] };
    expect(data.tasks.map((t) => t.title)).toContain("Nouvelle");
  });

  it("route POST /api/tasks/[id]/transition applique la transition", async () => {
    await ctx.handle.db.insert(tasks).values(taskToRow({ ...task("task-t"), actionIds: [] }));
    const response = await postTransition(
      jsonRequest("http://localhost/api/tasks/task-t/transition", { to: "running" }, cookie),
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
      jsonRequest(
        "http://localhost/api/actions/action-d/decision",
        {
          decidedByLabel: "Opérateur (simulé)",
          decision: "approved",
        },
        cookie,
      ),
      params("action-d"),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { execution: { outcome: string } };
    expect(data.execution.outcome).toBe("allowed");

    // Audit chronologique via la route.
    const audit = await getAudit(
      new Request("http://localhost/api/audit?actionId=action-d", { headers: { cookie } }),
    );
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
