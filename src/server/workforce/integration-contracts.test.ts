import { beforeEach, describe, expect, it } from "vitest";

import { checkMemoryAccess, effectiveMemoryScope } from "@/core/workforce/authority";
import { executionRecordSchema } from "@/core/workforce/contracts";
import type { Principal } from "@/core/workforce/governance";
import { agent, child, grant, NOW, policy } from "@/core/workforce/test-fixtures";

import type { WorkforceRuntime } from "./composition";
import { createPrincipalAuthority, UntrustedPrincipalError } from "./principals";
import {
  as,
  authority,
  buildOrg,
  head,
  makeService,
  owner,
  req,
  sessionOf,
  specialist,
  system,
} from "./test-support";
import { WorkforceDeniedError, type WorkforceService } from "./workforce-service";

/**
 * Integration contracts (decision 0056 §integration): principal boundary, CORE3 compute port,
 * Tool Gateway grant port, Cognitive Runtime memory port, Cockpit read model.
 */

let service: WorkforceService;
let runtime: WorkforceRuntime;

async function securityOrg() {
  ({ service, runtime } = makeService());
  await buildOrg(service, ["CYBER_SECURITY_LEAD", "APPSEC_SPECIALIST"]);
  await head(
    service,
    "security-lead",
    "CYBER_SECURITY_LEAD",
    "security",
    ["repo_read", "scanners", "logs"],
    ["icos"],
  );
  await specialist(
    service,
    "security-lead",
    "appsec-1",
    "APPSEC_SPECIALIST",
    ["repo_read", "scanners"],
    ["icos"],
  );
}

describe("principal boundary", () => {
  beforeEach(securityOrg);

  it("a public caller cannot forge the system principal: literal, JSON copy, spread and foreign authority are refused", async () => {
    const assignmentId = "wfa-any";
    const forgeries: unknown[] = [
      { kind: "system", id: "core3-dispatch", tenantId: "default", permissions: [] },
      JSON.parse(JSON.stringify(system)),
      { ...system },
      createPrincipalAuthority().runtime.system("core3-dispatch"),
    ];
    for (const forged of forgeries) {
      await expect(
        service.recordExecution(forged as Principal, assignmentId, {
          workerId: "w",
          result: "succeeded",
          source: "REAL",
          startedAt: NOW,
          finishedAt: NOW,
          evidence: ["x"],
        }),
      ).rejects.toBeInstanceOf(UntrustedPrincipalError);
      await expect(
        runtime.compute.requestFor(forged as Principal, assignmentId),
      ).rejects.toBeInstanceOf(WorkforceDeniedError);
      await expect(
        runtime.authority.checkToolGrant(forged as Principal, {
          agentId: "appsec-1",
          toolId: "repo_read",
          action: "read",
        }),
      ).rejects.toBeInstanceOf(WorkforceDeniedError);
    }
  });

  it("forged humans and agents are refused; only the runtime makes an agent act", async () => {
    await expect(service.listAgents({ ...owner })).rejects.toBeInstanceOf(UntrustedPrincipalError);
    expect(() => authority.runtime.actAsAgent({ ...system }, "appsec-1")).toThrow(
      UntrustedPrincipalError,
    );
    expect(() => authority.runtime.actAsAgent(owner, "appsec-1")).toThrow(UntrustedPrincipalError);
    expect(() => authority.runtime.system("http-route" as never)).toThrow(UntrustedPrincipalError);
    // Issued principals are frozen: no in-place elevation.
    expect(() => (owner.permissions as string[]).push("agents.manage")).toThrow();
    expect(Object.isFrozen(system)).toBe(true);
  });

  it("session → principal keeps the identity, derives permissions from roles, and a disabled user holds none", async () => {
    expect(owner).toMatchObject({ kind: "human", id: "owner-1", tenantId: "default" });
    expect(owner.permissions).toEqual(
      expect.arrayContaining(["agents.manage", "approvals.decide", "cockpit.read"]),
    );
    const viewer = sessionOf("viewer-1", ["viewer"]);
    expect(viewer.permissions).toContain("cockpit.read");
    expect(viewer.permissions).not.toContain("agents.manage");
    const disabled = authority.sessions.fromSession({
      user: { id: "gone", email: "g@icos.test", status: "disabled" },
      roles: ["owner"],
    });
    expect(disabled.permissions).toEqual([]);
    await expect(service.changeStatus(disabled, "appsec-1", "blocked")).rejects.toBeInstanceOf(
      WorkforceDeniedError,
    );
  });

  it("an HTTP caller holding only the session facet cannot reach the runtime facet", () => {
    expect(Object.keys(runtime.sessions)).toEqual(["fromSession"]);
  });
});

describe("CORE3 compute port", () => {
  beforeEach(securityOrg);

  async function assigned() {
    const top = await service.delegate(as("icos-central"), {
      requests: [req("mission-sec", "audit", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    await service.start(as("security-lead"), top.assignments[0].assignmentId);
    const sub = await service.delegate(as("security-lead"), {
      requests: [req("mission-sec", "appsec", ["appsec"], "icos")],
      parentAssignmentId: top.assignments[0].assignmentId,
    });
    return sub.assignments[0];
  }

  it("role/skill → capabilities + difficulty, never a model; lineage and approval travel with it", async () => {
    const a = await assigned();
    const request = await runtime.compute.requestFor(system, a.assignmentId, {
      taskRisk: "read_only",
    });
    expect(request).toMatchObject({
      missionId: "mission-sec",
      taskId: "appsec",
      agent: { agentId: "appsec-1", roleId: "APPSEC_SPECIALIST" },
      skillId: "APPSEC_REVIEW",
      requiredCapabilities: ["appsec"],
      compute: { complexity: "high", risk: "read_only", workerCapabilities: [], modelHints: [] },
      workerRequirement: { requiredCapabilities: [] },
      approval: { required: false, satisfied: true },
    });
    expect(JSON.stringify(request)).not.toMatch(
      /"model(Key|Id)?"|opus|sonnet|haiku|gpt|nemotron|claude/i,
    );
  });

  it("evidence keeps selection and effective compute apart; an unsteered run cannot claim an effective model", async () => {
    const a = await assigned();
    await service.start(as("appsec-1"), a.assignmentId);
    const lie = {
      workerId: "w-1",
      result: "succeeded" as const,
      source: "REAL" as const,
      startedAt: NOW,
      finishedAt: NOW,
      evidence: ["x"],
      modelSteered: false,
      selected: { modelKey: "p/m" },
      effective: { modelKey: "p/m" },
    };
    expect(() => executionRecordSchema.parse(lie)).toThrow();
    const done = await runtime.compute.recordExecution(system, a.assignmentId, {
      workerId: "w-1",
      selected: { modelKey: "gateway/selected-model", provider: "gateway" },
      modelSteered: false,
      result: "succeeded",
      source: "REAL",
      startedAt: "2026-09-29T10:00:00.000Z",
      finishedAt: "2026-09-29T10:00:30.000Z",
      evidence: ["git://abc123"],
      costCents: 4,
      tokens: 1200,
      review: { reviewerWorkerId: "w-reviewer", outcome: "APPROVE" },
    });
    expect(done).toMatchObject({
      status: "accepted",
      execution: {
        requestedCapabilities: ["appsec"],
        selected: { modelKey: "gateway/selected-model" },
      },
      review: { reviewerWorkerId: "w-reviewer" },
    });
    expect(done.execution?.effective).toBeUndefined();
    const perf = await service.performance(owner);
    expect(perf).toMatchObject({
      count: 1,
      successRate: 1,
      meanLatencyMs: 30_000,
      totalCostCents: 4,
    });
    const snapshot = await runtime.readModel.snapshot(owner);
    expect(snapshot.agents.find((x) => x.agentId === "appsec-1")?.performance.count).toBe(1);
  });

  it("a failed execution is recorded with its failure class and returns the work for another attempt", async () => {
    const a = await assigned();
    await service.start(as("appsec-1"), a.assignmentId);
    const after = await runtime.compute.recordExecution(system, a.assignmentId, {
      workerId: "w-1",
      result: "failed",
      failureClass: "EXECUTION_TIMEOUT",
      source: "REAL",
      startedAt: NOW,
      finishedAt: NOW,
      evidence: ["log://timeout"],
    });
    expect(after.status).toBe("assigned");
    expect(await service.performance(owner)).toMatchObject({
      count: 1,
      successRate: 0,
      failureClasses: { EXECUTION_TIMEOUT: 1 },
    });
    await expect(
      runtime.compute.recordExecution(system, a.assignmentId, {
        workerId: "w-1",
        result: "failed",
        source: "REAL",
        startedAt: NOW,
        finishedAt: NOW,
        evidence: ["x"],
      }),
    ).rejects.toThrow();
  });

  it("an execution worker's evidence must name its own registered worker", async () => {
    await specialist(
      service,
      "security-lead",
      "worker-agent",
      "APPSEC_SPECIALIST",
      ["repo_read", "scanners"],
      ["icos"],
      "EXECUTION_WORKER",
    );
    const top = await service.delegate(as("icos-central"), {
      requests: [req("mission-sec", "audit", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    await service.start(as("security-lead"), top.assignments[0].assignmentId);
    const sub = await service.delegate(as("security-lead"), {
      requests: [
        req("mission-sec", "a1", ["appsec"], "icos"),
        req("mission-sec", "a2", ["appsec"], "icos"),
      ],
      parentAssignmentId: top.assignments[0].assignmentId,
    });
    const mine = sub.assignments.find((x) => x.assigneeAgentId === "worker-agent")!;
    await service.start(as("worker-agent"), mine.assignmentId);
    const evidence = {
      result: "succeeded" as const,
      source: "REAL" as const,
      startedAt: NOW,
      finishedAt: NOW,
      evidence: ["x"],
    };
    await expect(
      runtime.compute.recordExecution(system, mine.assignmentId, {
        ...evidence,
        workerId: "someone-else",
      }),
    ).rejects.toBeInstanceOf(WorkforceDeniedError);
    expect(
      (
        await runtime.compute.recordExecution(system, mine.assignmentId, {
          ...evidence,
          workerId: "worker-worker-agent",
        })
      ).status,
    ).toBe("in_review");
  });

  it("CORE3's reviewer worker must not be the executing worker", async () => {
    const a = await assigned();
    await service.start(as("appsec-1"), a.assignmentId);
    await expect(
      runtime.compute.recordExecution(system, a.assignmentId, {
        workerId: "w-1",
        result: "succeeded",
        source: "REAL",
        startedAt: NOW,
        finishedAt: NOW,
        evidence: ["x"],
        review: { reviewerWorkerId: "w-1", outcome: "APPROVE" },
      }),
    ).rejects.toBeInstanceOf(WorkforceDeniedError);
  });
});

describe("Tool Gateway grant port — skill ≠ permission, role ≠ permission, tool ≠ action", () => {
  beforeEach(securityOrg);
  const check = (
    agentId: string,
    toolId: string,
    action: string,
    extra: Record<string, string> = {},
  ) =>
    runtime.authority.checkToolGrant(system, {
      agentId,
      toolId,
      action,
      clientId: "icos",
      missionId: "mission-x",
      ...extra,
    });

  it("grants the granted action in scope, with provenance", async () => {
    expect(await check("appsec-1", "scanners", "run")).toMatchObject({
      granted: true,
      grant: { toolId: "scanners", grantedBy: "owner-1", delegatedBy: "security-lead" },
    });
  });

  it("a skill needing a tool is not a grant: APPSEC's skill needs repo_read, the lead's role needs logs — only live grants count", async () => {
    expect(await check("appsec-1", "logs", "read")).toMatchObject({
      granted: false,
      reasons: ["NOT_GRANTED"],
    });
  });

  it("holding a tool is not holding every action on it", async () => {
    await specialist(service, "security-lead", "appsec-ro", "APPSEC_SPECIALIST", [], ["icos"]);
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await service.changePolicy(owner, "security-lead", {
      ...lead.policy,
      toolGrants: lead.policy.toolGrants.map((g) =>
        g.toolId === "repo_read" ? { ...g, actions: ["read"], grantedAt: NOW } : g,
      ),
    });
    expect(await check("security-lead", "repo_read", "write")).toMatchObject({
      granted: false,
      reasons: ["ACTION_NOT_GRANTED"],
    });
    expect((await check("security-lead", "repo_read", "read")).granted).toBe(true);
  });

  it("revocation is observable at the next call — on the agent or anywhere up its chain", async () => {
    const before = await check("appsec-1", "scanners", "run");
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await service.changePolicy(owner, "security-lead", {
      ...lead.policy,
      toolGrants: lead.policy.toolGrants.filter((g) => g.toolId !== "scanners"),
    });
    const after = await check("appsec-1", "scanners", "run");
    expect(after).toMatchObject({ granted: false, reasons: ["TOOL_NOT_HELD_BY_PARENT"] });
    expect(after.chainVersion).not.toBe(before.chainVersion);
    await service.changeStatus(owner, "security-lead", "suspended");
    expect((await check("appsec-1", "repo_read", "read")).reasons).toContain("ANCESTOR_NOT_ACTIVE");
  });

  it("an agent whose autonomy now exceeds an ancestor's is refused tools (autonomy drift)", async () => {
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await service.changePolicy(owner, "security-lead", { ...lead.policy, autonomyLevel: 0 });
    expect((await check("appsec-1", "scanners", "run")).reasons).toContain(
      "AUTONOMY_EXCEEDS_PARENT",
    );
  });

  it("scope and mission bound the grant", async () => {
    expect(
      (await check("appsec-1", "scanners", "run", { clientId: "belle-intendance" })).reasons,
    ).toContain("SCOPE_ESCAPE");
    expect(
      (await check("appsec-1", "scanners", "run", { missionId: "another" })).reasons,
    ).toContain("MISSION_MISMATCH");
    expect((await check("ghost", "scanners", "run")).reasons).toEqual(["AGENT_UNKNOWN"]);
  });
});

describe("Cognitive Runtime memory port — memory authority never widens down the hierarchy", () => {
  beforeEach(securityOrg);

  it("a child cannot be created with broader visibility or other namespaces", async () => {
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    const base = {
      kind: "EPHEMERAL_SPECIALIST" as const,
      roleId: "APPSEC_SPECIALIST",
      roleVersion: "1.0.0",
      displayName: "x",
      supervisorAgentId: "security-lead",
      scope: { clientIds: ["icos"], projectIds: ["*"] },
      missionId: "m",
      expiresAt: "2026-09-30T10:00:00.000Z",
      policy: {
        ...lead.policy,
        toolGrants: [],
        budget: { computeUnits: 10, financialCents: 0 },
        bounds: { maxDepth: 3, maxDescendants: 0, maxConcurrentAssignments: 1 },
      },
    };
    for (const memoryScope of [
      { read: ["tenant/default"], write: [], maxVisibility: "tenant" as const },
      { read: ["tenant/other"], write: [] },
    ]) {
      const agentId = `bad-${Math.abs(JSON.stringify(memoryScope).length)}`;
      await expect(
        service.createAgent(as("security-lead"), { ...base, agentId, memoryScope }),
      ).rejects.toBeInstanceOf(WorkforceDeniedError);
    }
    const denials = (await service.listEvents(owner)).filter((e) => e.type === "governance.denied");
    expect(
      denials.every((e) => (e.details.violations as string[]).includes("MEMORY_SCOPE_ESCAPE")),
    ).toBe(true);
  });

  it("the effective scope is the intersection with every ancestor as they are NOW", async () => {
    const parent = agent({
      memoryScope: {
        read: ["tenant/default/client/a"],
        write: [],
        maxVisibility: "restricted",
        retentionDays: 30,
      },
    });
    const kid = child(parent, {
      memoryScope: {
        read: ["tenant/default/client/a/notes", "tenant/default/client/b"],
        write: [],
        maxVisibility: "tenant",
        retentionDays: 90,
      },
      policy: policy({ toolGrants: [grant("repo_read", { delegatedBy: parent.agentId })] }),
    });
    const scope = effectiveMemoryScope({ chain: [kid, parent], broken: false }, NOW)!;
    expect(scope).toMatchObject({
      read: ["tenant/default/client/a/notes"],
      maxVisibility: "restricted",
      retentionDays: 30,
      active: true,
    });
    expect(
      checkMemoryAccess(scope, {
        namespace: "tenant/default/client/b",
        mode: "read",
        clientId: "belle-intendance",
        missionId: "mission-1",
      }).reasons,
    ).toEqual(["NAMESPACE_NOT_ALLOWED"]);
    expect(
      checkMemoryAccess(scope, {
        namespace: "tenant/default/client/a/notes",
        mode: "read",
        visibility: "tenant",
        clientId: "belle-intendance",
        missionId: "mission-1",
      }).reasons,
    ).toEqual(["VISIBILITY_TOO_BROAD"]);
  });

  it("siblings do not share authority: one sibling's namespaces are not the other's", async () => {
    await service.createAgent(as("security-lead"), {
      agentId: "sib-a",
      kind: "EPHEMERAL_SPECIALIST",
      roleId: "APPSEC_SPECIALIST",
      roleVersion: "1.0.0",
      displayName: "a",
      supervisorAgentId: "security-lead",
      scope: { clientIds: ["icos"], projectIds: [] },
      memoryScope: { read: ["tenant/default/mission/m/a"], write: ["tenant/default/mission/m/a"] },
      missionId: "m",
      expiresAt: "2026-09-30T10:00:00.000Z",
      policy: {
        autonomyLevel: 1,
        toolGrants: [],
        budget: { computeUnits: 10, financialCents: 0 },
        bounds: { maxDepth: 3, maxDescendants: 0, maxConcurrentAssignments: 1 },
      },
    });
    const access = await runtime.authority.checkMemoryAccess(system, {
      agentId: "sib-a",
      namespace: "tenant/default/mission/m/b",
      mode: "read",
      clientId: "icos",
      missionId: "m",
    });
    expect(access).toEqual({ allowed: false, reasons: ["NAMESPACE_NOT_ALLOWED"] });
    const own = await runtime.authority.checkMemoryAccess(system, {
      agentId: "sib-a",
      namespace: "tenant/default/mission/m/a",
      mode: "write",
      visibility: "private",
      clientId: "icos",
      missionId: "m",
    });
    expect(own).toEqual({ allowed: true, reasons: [] });
  });
});

describe("Cockpit read model", () => {
  beforeEach(securityOrg);

  it("projects the organisation read-only and flags degraded agents", async () => {
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await service.changePolicy(owner, "security-lead", {
      ...lead.policy,
      toolGrants: lead.policy.toolGrants.filter((g) => g.toolId !== "scanners"),
    });
    const snap = await runtime.readModel.snapshot(sessionOf("viewer-1", ["viewer"]));
    expect(snap.departments.length).toBe(10);
    expect(snap.roles.length).toBe(24);
    expect(snap.skills.length).toBe(25);
    const appsec = snap.agents.find((a) => a.agentId === "appsec-1")!;
    expect(appsec).toMatchObject({
      kind: "EPHEMERAL_SPECIALIST",
      health: "degraded",
      healthReasons: ["TOOL_NOT_HELD_BY_PARENT"],
      autonomyLevel: 1,
    });
    expect(snap.agents.find((a) => a.agentId === "security-lead")?.budget).toMatchObject({
      computeUnits: 1000,
      allocatedToReports: 100,
    });
    expect(
      Object.isFrozen(snap) &&
        Object.isFrozen(snap.agents[0]) &&
        Object.isFrozen(snap.agents[0].toolGrants),
    ).toBe(true);
    expect(() => ((snap.agents as unknown[]).length = 0)).toThrow();
    // The projection holds copies: stored state is unchanged by anything done to it.
    expect((await service.listAgents(owner)).length).toBe(snap.agents.length);
  });

  it("requires cockpit.read (or the runtime) and an issued principal", async () => {
    await expect(runtime.readModel.snapshot(sessionOf("nobody", []))).rejects.toBeInstanceOf(
      WorkforceDeniedError,
    );
    await expect(runtime.readModel.snapshot({ ...owner })).rejects.toBeInstanceOf(
      WorkforceDeniedError,
    );
    await expect(runtime.readModel.snapshot(as("appsec-1"))).rejects.toBeInstanceOf(
      WorkforceDeniedError,
    );
  });
});
