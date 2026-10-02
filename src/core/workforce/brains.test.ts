import { describe, expect, it } from "vitest";

import { MODEL_FAMILIES } from "@/core/workers/compute-routing";

import brainsData from "./bootstrap/brains.json";
import { loadWorkforceBootstrap } from "./bootstrap";
import {
  BRAIN_IDS,
  BUILDER_BRAIN_ID,
  CHIEF_BRAIN_ID,
  EVOLUTION_BRAIN_ID,
  loadBrains,
} from "./brains";
import { workforceAgentSchema } from "./contracts";
import { evaluatePolicyChange, type Principal } from "./governance";

const CTX = {
  tenantId: "default",
  createdBy: { kind: "human" as const, id: "owner-1" },
  now: "2026-10-02T09:00:00.000Z",
};

describe("canonical brains (seeded onto the existing workforce schema)", () => {
  const brains = loadBrains(CTX);
  const bootstrap = loadWorkforceBootstrap();
  const byId = new Map(brains.map((b) => [b.agentId, b]));

  it("seeds exactly the 12 canonical brains, every one a valid DURABLE_AGENT", () => {
    expect(brains).toHaveLength(12);
    expect(BRAIN_IDS).toHaveLength(12);
    for (const b of brains) {
      expect([b.agentId, workforceAgentSchema.safeParse(b).success]).toEqual([b.agentId, true]);
      expect([b.agentId, b.kind]).toEqual([b.agentId, "DURABLE_AGENT"]);
      expect(b.missionId).toBeUndefined();
      expect(b.expiresAt).toBeUndefined();
      expect(b.workerId).toBeUndefined();
    }
  });

  it("gives every brain a deterministic, unique id, stable across two loads", () => {
    expect(new Set(brains.map((b) => b.agentId)).size).toBe(12);
    expect(brains.map((b) => b.agentId)).toEqual([...BRAIN_IDS]);
    // Idempotence by agentId: a second seed cannot create a duplicate.
    expect(loadBrains(CTX)).toEqual(brains);
  });

  it("has exactly one root and no self-supervision, parents before children", () => {
    const roots = brains.filter((b) => b.supervisorAgentId === null);
    expect(roots.map((b) => b.agentId)).toEqual([CHIEF_BRAIN_ID]);
    expect(roots[0]!.depth).toBe(0);
    const seen = new Set<string>();
    for (const b of brains) {
      expect(b.supervisorAgentId).not.toBe(b.agentId);
      expect(b.parentAgentId).not.toBe(b.agentId);
      if (b.supervisorAgentId !== null) expect(seen.has(b.supervisorAgentId)).toBe(true);
      seen.add(b.agentId);
    }
  });

  it("reuses existing role templates and never exceeds the role's autonomy ceiling", () => {
    for (const b of brains) {
      const role = bootstrap.roles.find(
        (r) => r.roleId === b.roleId && r.version === b.roleVersion,
      );
      expect([b.agentId, role?.roleId]).toEqual([b.agentId, b.roleId]);
      expect(role!.agentKinds).toContain("DURABLE_AGENT");
      expect([b.agentId, b.policy.autonomyLevel <= role!.autonomyCeiling]).toEqual([
        b.agentId,
        true,
      ]);
    }
  });

  it("restates no capability on a brain: the role's skills are the single source", () => {
    for (const entry of brainsData) {
      expect(Object.keys(entry).filter((k) => /capabilit|skill/i.test(k))).toEqual([]);
    }
  });

  it("grants nothing: no tool, no money, no client scope without a human", () => {
    for (const b of brains) {
      expect([b.agentId, b.policy.toolGrants]).toEqual([b.agentId, []]);
      expect([b.agentId, b.policy.budget.financialCents]).toEqual([b.agentId, 0]);
      expect([b.agentId, b.scope]).toEqual([b.agentId, { clientIds: [], projectIds: [] }]);
    }
  });

  it("keeps Evolution no higher than Builder and tool-less", () => {
    const evolution = byId.get(EVOLUTION_BRAIN_ID)!;
    const builder = byId.get(BUILDER_BRAIN_ID)!;
    expect(evolution.policy.autonomyLevel).toBeLessThanOrEqual(builder.policy.autonomyLevel);
    expect(evolution.policy.toolGrants).toEqual([]);
  });

  it("binds no brain to a model: hints are ordered, known families, never authority", () => {
    const evolution = byId.get(EVOLUTION_BRAIN_ID)!;
    const chief = byId.get(CHIEF_BRAIN_ID)!;
    for (const b of brains) {
      for (const hint of b.compute?.modelHints ?? [])
        expect(MODEL_FAMILIES as readonly string[]).toContain(hint);
    }
    // The strongest compute hint carries the lowest autonomy: capability is not authority.
    expect(evolution.compute!.modelHints[0]).toBe("CLAUDE_FABLE");
    expect(evolution.policy.autonomyLevel).toBeLessThan(chief.policy.autonomyLevel);
  });

  it("refuses a brain raising its own or another brain's authority", () => {
    const chief = byId.get(CHIEF_BRAIN_ID)!;
    const builder = byId.get(BUILDER_BRAIN_ID)!;
    const asChief: Principal = {
      kind: "agent",
      id: chief.agentId,
      tenantId: CTX.tenantId,
      permissions: ["agents.manage"],
    };
    const role = bootstrap.roles.find((r) => r.roleId === chief.roleId)!;
    expect(
      evaluatePolicyChange({
        principal: asChief,
        target: chief,
        next: { ...chief.policy, autonomyLevel: 3 },
        supervisor: null,
        role,
        now: CTX.now,
      }),
    ).toEqual({ allowed: false, violations: ["SELF_MODIFICATION", "ACTOR_NOT_AUTHORIZED"] });
    expect(
      evaluatePolicyChange({
        principal: asChief,
        target: builder,
        next: { ...builder.policy, autonomyLevel: 3 },
        supervisor: chief,
        role: bootstrap.roles.find((r) => r.roleId === builder.roleId)!,
        now: CTX.now,
      }),
    ).toMatchObject({ allowed: false });
  });

  it("stays inside the organisation bounds and the Chief's allocation", () => {
    const chief = byId.get(CHIEF_BRAIN_ID)!;
    const reports = brains.filter((b) => b.supervisorAgentId === chief.agentId);
    expect(brains.length).toBeLessThanOrEqual(bootstrap.bounds.maxAgents);
    for (const b of brains) {
      expect(b.depth).toBeLessThanOrEqual(bootstrap.bounds.maxDepth);
      expect(b.policy.bounds.maxConcurrentAssignments).toBeLessThanOrEqual(
        bootstrap.bounds.maxConcurrentAssignmentsPerAgent,
      );
      if (b.departmentId !== null)
        expect(bootstrap.departments.map((d) => d.departmentId)).toContain(b.departmentId);
    }
    expect(reports.reduce((s, b) => s + b.policy.budget.computeUnits, 0)).toBeLessThanOrEqual(
      chief.policy.budget.computeUnits,
    );
  });

  it("takes the tenant from the caller and never hardcodes one", () => {
    const other = loadBrains({ ...CTX, tenantId: "tenant-b" });
    expect(other.every((b) => b.tenantId === "tenant-b")).toBe(true);
    expect(
      other.every((b) => b.memoryScope.read.every((n) => n.startsWith("tenant/tenant-b"))),
    ).toBe(true);
    expect(JSON.stringify(brainsData)).not.toMatch(/tenant-|"default"/);
  });

  it("refuses to load with an invalid clock: bad data never becomes a brain", () => {
    expect(() => loadBrains({ ...CTX, now: "not-a-date" })).toThrow();
  });
});
