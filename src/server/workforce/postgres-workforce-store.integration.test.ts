import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Principal } from "@/core/workforce/governance";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { PostgresWorkforceStore } from "./postgres-workforce-store";
import { UntrustedPrincipalError } from "./principals";
import {
  as,
  buildOrg,
  execute,
  head,
  makeService,
  owner,
  req,
  specialist,
  system,
} from "./test-support";
import { WorkforceDeniedError } from "./workforce-service";

/**
 * PostgreSQL proofs for the digital workforce (migration 0051, decision 0057): durability
 * across a new store instance, append-only journal, terminal BLOCK at the database boundary,
 * tenant isolation, transactional denial, serialised bounds under concurrency.
 */

const pgCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "NO_ERROR";
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "UNKNOWN";
  }
};

describe.skipIf(!dockerAvailable)("PostgresWorkforceStore (Testcontainers)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await stopPostgres(ctx);
  });
  beforeEach(async () => {
    await ctx.handle.db.execute(
      sql`TRUNCATE workforce_events, workforce_performance_observations, workforce_assignments, workforce_agents, workforce_departments, workforce_roles, workforce_skills`,
    );
  });

  const newService = () => makeService(new PostgresWorkforceStore(ctx.handle.db)).service;

  async function securityOrg() {
    const service = newService();
    await buildOrg(service, ["CYBER_SECURITY_LEAD", "APPSEC_SPECIALIST"]);
    await head(
      service,
      "security-lead",
      "CYBER_SECURITY_LEAD",
      "security",
      ["repo_read", "scanners", "logs"],
      ["icos"],
      1,
    );
    return service;
  }

  it("a full delegation is durable: a NEW store instance reads the same lineage, reviews and journal", async () => {
    const service = await securityOrg();
    const top = await service.delegate(as("icos-central"), {
      requests: [req("mission-sec", "audit", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    await service.start(as("security-lead"), top.assignments[0].assignmentId);
    await specialist(
      service,
      "security-lead",
      "appsec-1",
      "APPSEC_SPECIALIST",
      ["repo_read", "scanners"],
      ["icos"],
    );
    const sub = await service.delegate(as("security-lead"), {
      requests: [req("mission-sec", "appsec", ["appsec"], "icos")],
      parentAssignmentId: top.assignments[0].assignmentId,
    });
    await execute(service, sub.assignments[0], "security-lead");

    const restarted = newService();
    const assignments = (await restarted.listAssignments(owner)).sort((x, y) =>
      y.taskId.localeCompare(x.taskId),
    );
    expect(assignments.map((a) => [a.taskId, a.status, a.parentAssignmentId])).toEqual([
      ["audit", "executing", null],
      ["appsec", "accepted", top.assignments[0].assignmentId],
    ]);
    expect(assignments[1]).toMatchObject({
      execution: { workerId: "worker-appsec-1", source: "SIMULATED" },
      review: { reviewerAgentId: "security-lead", outcome: "APPROVE" },
    });
    const events = await restarted.listEvents(owner);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "agent.spawned",
        "assignment.created",
        "assignment.reviewed",
        "observation.recorded",
      ]),
    );
    expect(await restarted.performance(owner, { includeNonReal: true })).toMatchObject({
      count: 1,
      successRate: 1,
    });
  });

  it("the journal and the observations are append-only at the database (IC002)", async () => {
    const service = await securityOrg();
    expect((await service.listEvents(owner)).length).toBeGreaterThan(0);
    expect(
      await pgCode(ctx.handle.db.execute(sql`UPDATE workforce_events SET subject_id = 'x'`)),
    ).toBe("IC002");
    expect(await pgCode(ctx.handle.db.execute(sql`DELETE FROM workforce_events`))).toBe("IC002");
    expect(
      await pgCode(
        ctx.handle.db.execute(
          sql`UPDATE workforce_performance_observations SET agent_id = 'x' WHERE false`,
        ),
      ),
    ).toBe("NO_ERROR");
  });

  it("BLOCK is terminal at the database boundary too (IC003), even bypassing the service", async () => {
    const service = await securityOrg();
    await service.changeStatus(owner, "security-lead", "blocked");
    expect(
      await pgCode(
        ctx.handle.db.execute(
          sql`UPDATE workforce_agents SET status = 'active' WHERE agent_id = 'security-lead'`,
        ),
      ),
    ).toBe("IC003");
    expect(
      await pgCode(
        ctx.handle.db.execute(sql`DELETE FROM workforce_agents WHERE agent_id = 'security-lead'`),
      ),
    ).toBe("IC003");
    await expect(service.changeStatus(owner, "security-lead", "active")).rejects.toBeInstanceOf(
      WorkforceDeniedError,
    );
  });

  it("tenants are isolated: another tenant sees nothing, and composite keys forbid cross-tenant references", async () => {
    await securityOrg();
    // Single-tenant shim: no principal can carry another tenant; a forged one is refused.
    const forged: Principal = { ...owner, tenantId: "tenant-b" };
    await expect(newService().listAgents(forged)).rejects.toBeInstanceOf(UntrustedPrincipalError);
    // Store level: every query carries the tenant predicate.
    const store = new PostgresWorkforceStore(ctx.handle.db);
    expect(await store.listAgents("tenant-b")).toEqual([]);
    expect(await store.listEvents("tenant-b")).toEqual([]);
    expect((await store.listAgents("default")).length).toBeGreaterThan(0);
    // A tenant-b agent cannot point at a tenant-a supervisor, whatever the application does.
    expect(
      await pgCode(
        ctx.handle.db
          .execute(sql`INSERT INTO workforce_agents (tenant_id, agent_id, kind, status, role_id, role_version, supervisor_agent_id, depth, version, spec, created_at, updated_at)
          VALUES ('tenant-b', 'intruder', 'DURABLE_AGENT', 'active', 'ICOS_CENTRAL', '1.0.0', 'icos-central', 1, 1, '{}', now(), now())`),
      ),
    ).toBe("23503");
  });

  it("a denied action writes nothing but its durable denial; a failed transaction leaves no event", async () => {
    const service = await securityOrg();
    const before = await service.listAgents(owner);
    await expect(
      service.changePolicy(as("security-lead"), "security-lead", {
        ...before.find((a) => a.agentId === "security-lead")!.policy,
        autonomyLevel: 3,
      }),
    ).rejects.toBeInstanceOf(WorkforceDeniedError);
    expect(await service.listAgents(owner)).toEqual(before);
    const events = await service.listEvents(owner);
    expect(events.at(-1)).toMatchObject({
      type: "governance.denied",
      actor: { id: "security-lead" },
    });

    // Duplicate agent id: the insert fails inside the transaction, so its event rolls back too.
    const count = events.length;
    await expect(
      head(service, "security-lead", "CYBER_SECURITY_LEAD", "security", ["repo_read"], ["icos"]),
    ).rejects.toThrow();
    expect((await service.listEvents(owner)).length).toBe(count);
  });

  it("spawn bounds hold under concurrency: two parallel spawns against maxDescendants = 1 yield exactly one agent", async () => {
    await securityOrg();
    const a = newService();
    const b = newService();
    const results = await Promise.allSettled([
      specialist(a, "security-lead", "appsec-a", "APPSEC_SPECIALIST", ["repo_read"], ["icos"]),
      specialist(b, "security-lead", "appsec-b", "APPSEC_SPECIALIST", ["repo_read"], ["icos"]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(WorkforceDeniedError);
    expect((rejected.reason as WorkforceDeniedError).violations).toContain("MAX_DESCENDANTS");
    const spawned = (await newService().listAgents(owner)).filter(
      (x) => x.parentAgentId === "security-lead",
    );
    expect(spawned).toHaveLength(1);
  });

  it("workforce writes of one tenant are serialised: a spawn waits while another transaction holds the tenant", async () => {
    await securityOrg();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = new PostgresWorkforceStore(ctx.handle.db).transaction("default", () => gate);
    await new Promise((r) => setTimeout(r, 100));
    let spawned = false;
    const spawn = specialist(
      newService(),
      "security-lead",
      "appsec-a",
      "APPSEC_SPECIALIST",
      ["repo_read"],
      ["icos"],
    ).then(() => {
      spawned = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(spawned).toBe(false);
    release();
    await holder;
    await spawn;
    expect(spawned).toBe(true);
    // Another tenant is not blocked by this tenant's lock.
    const otherTenant = new PostgresWorkforceStore(ctx.handle.db).transaction(
      "tenant-b",
      async () => "ran",
    );
    await expect(otherTenant).resolves.toBe("ran");
  });

  it("integration ports on durable state: CORE3 evidence, tool revocation and the cockpit read model survive a new runtime", async () => {
    const service = await securityOrg();
    await specialist(
      service,
      "security-lead",
      "appsec-1",
      "APPSEC_SPECIALIST",
      ["repo_read", "scanners"],
      ["icos"],
    );
    const top = await service.delegate(as("icos-central"), {
      requests: [req("m-sec", "audit", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    await service.start(as("security-lead"), top.assignments[0].assignmentId);
    const sub = await service.delegate(as("security-lead"), {
      requests: [req("m-sec", "appsec", ["appsec"], "icos")],
      parentAssignmentId: top.assignments[0].assignmentId,
    });
    await service.start(as("appsec-1"), sub.assignments[0].assignmentId);

    const pg = () => makeService(new PostgresWorkforceStore(ctx.handle.db)).runtime;
    await pg().compute.recordExecution(system, sub.assignments[0].assignmentId, {
      workerId: "w-1",
      selected: { modelKey: "gw/selected" },
      effective: { modelKey: "gw/effective" },
      modelSteered: true,
      result: "succeeded",
      source: "REAL",
      startedAt: "2026-09-29T10:00:00.000Z",
      finishedAt: "2026-09-29T10:00:10.000Z",
      evidence: ["git://sha"],
      review: { reviewerWorkerId: "w-2", outcome: "APPROVE" },
    });
    const grantCheck = {
      agentId: "appsec-1",
      toolId: "scanners",
      action: "run",
      clientId: "icos",
      missionId: "mission-x",
    };
    expect((await pg().authority.checkToolGrant(system, grantCheck)).granted).toBe(true);
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await service.changePolicy(owner, "security-lead", {
      ...lead.policy,
      toolGrants: lead.policy.toolGrants.filter((g) => g.toolId !== "scanners"),
    });
    expect(await pg().authority.checkToolGrant(system, grantCheck)).toMatchObject({
      granted: false,
      reasons: ["TOOL_NOT_HELD_BY_PARENT"],
    });

    const snap = await pg().readModel.snapshot(owner);
    const appsec = snap.agents.find((a) => a.agentId === "appsec-1")!;
    expect(appsec).toMatchObject({ health: "degraded", performance: { count: 1, successRate: 1 } });
    expect(snap.performance).toMatchObject({ count: 1, successRate: 1 });
    const stored = (await pg().service.listAssignments(owner)).find((a) => a.taskId === "appsec")!;
    expect(stored.execution).toMatchObject({
      selected: { modelKey: "gw/selected" },
      effective: { modelKey: "gw/effective" },
    });
  });

  it("stale writers lose: compare-and-set on the agent version", async () => {
    await securityOrg();
    const store = new PostgresWorkforceStore(ctx.handle.db);
    const lead = (await store.getAgent("default", "security-lead"))!;
    expect(
      await store.updateAgent(
        { ...lead, displayName: "v2", version: lead.version + 1 },
        lead.version,
      ),
    ).toBe(true);
    expect(
      await store.updateAgent(
        { ...lead, displayName: "stale", version: lead.version + 1 },
        lead.version,
      ),
    ).toBe(false);
    expect((await store.getAgent("default", "security-lead"))!.displayName).toBe("v2");
  });
});
