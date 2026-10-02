import { beforeEach, describe, expect, it } from "vitest";

import { BRAIN_IDS, BRAIN_ROLES, CHIEF_BRAIN_ID } from "@/core/workforce/brains";
import { requiredRoleTests } from "@/core/workforce/role-composer";

import { seedBrains } from "./brain-seed";
import type { WorkforceStore } from "./ports";
import { bootstrap, certifier, makeService, owner, sessionOf } from "./test-support";
import type { WorkforceService } from "./workforce-service";

/**
 * The seeder of the twelve canonical brains (decision 0066): it is governed, it is idempotent,
 * and it refuses — loudly and per brain — rather than invent anything.
 */

let service: WorkforceService;
let store: WorkforceStore;

beforeEach(() => {
  ({ service, store } = makeService());
});

/** The PRECONDITION: templates loaded, then each reused role certified and activated. */
async function activateBrainRoles() {
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
}

const seed = () => seedBrains({ service, store }, owner);

describe("seedBrains", () => {
  it("creates the twelve brains, chief first, each on its reused active role", async () => {
    await activateBrainRoles();
    const report = await seed();

    expect(report.complete).toBe(true);
    expect(report.results.map((r) => r.agentId)).toEqual([...BRAIN_IDS]);
    expect(report.results.every((r) => r.outcome === "created")).toBe(true);
    expect(report.results[0].agentId).toBe(CHIEF_BRAIN_ID);

    const chief = await store.getAgent(owner.tenantId, CHIEF_BRAIN_ID);
    expect(chief).toMatchObject({ kind: "DURABLE_AGENT", depth: 0, supervisorAgentId: null });
    // A seed confers nothing: no tool grant, no money, and the tenant comes from the principal.
    expect(chief?.policy.toolGrants).toEqual([]);
    expect(chief?.policy.budget.financialCents).toBe(0);
    expect(chief?.tenantId).toBe(owner.tenantId);

    const agents = await store.listAgents(owner.tenantId);
    expect(agents).toHaveLength(12);
    expect(agents.filter((a) => a.supervisorAgentId === CHIEF_BRAIN_ID)).toHaveLength(11);
  });

  it("is idempotent: a second run creates nothing and duplicates nothing", async () => {
    await activateBrainRoles();
    await seed();
    const again = await seed();

    expect(again.complete).toBe(true);
    expect(again.results.every((r) => r.outcome === "already-present")).toBe(true);
    expect(await store.listAgents(owner.tenantId)).toHaveLength(12);
  });

  it("refuses every brain, with the reason, when the reused roles are not active", async () => {
    await service.seedBootstrap(owner, bootstrap); // templates only: roles stay DRAFT
    const report = await seed();

    expect(report.complete).toBe(false);
    expect(report.results).toHaveLength(12);
    expect(report.results[0]).toMatchObject({
      agentId: CHIEF_BRAIN_ID,
      outcome: "refused",
      violations: ["ROLE_NOT_ACTIVE"],
    });
    expect(await store.listAgents(owner.tenantId)).toEqual([]);
  });

  it("refuses a caller that does not hold `agents.manage`: data never creates a brain", async () => {
    await activateBrainRoles();
    const report = await seedBrains({ service, store }, sessionOf("viewer-1", ["viewer"]));

    expect(report.complete).toBe(false);
    expect(report.results.every((r) => r.outcome === "refused")).toBe(true);
    expect(report.results[0].violations).toContain("ACTOR_NOT_AUTHORIZED");
  });

  it("seeds each tenant separately: another tenant's brains are not this one's", async () => {
    await activateBrainRoles();
    await seed();
    expect(await store.listAgents("autre-tenant")).toEqual([]);
  });
});
