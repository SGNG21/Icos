import { loadBrains } from "@/core/workforce/brains";
import type { WorkforceAgent } from "@/core/workforce/contracts";
import type { Principal } from "@/core/workforce/governance";

import type { WorkforceStore } from "./ports";
import { WorkforceDeniedError, type AgentSpec, type WorkforceService } from "./workforce-service";

/**
 * SEEDING THE TWELVE CANONICAL BRAINS (decision 0066). `loadBrains` had no caller, so
 * `workforce_agents` was 0 rows; this is its caller.
 *
 * IT CREATES NO AUTHORITY. Every row goes through `WorkforceService.createAgent`, which is the
 * one authority for agent creation: it re-derives depth and spawn lineage, demands an `active`
 * role, enforces the organisational bounds, keeps a brain's policy inside its supervisor's, and
 * writes the `agent.created` event. A direct `store.insertAgent` would have been shorter and
 * would have been a second authority — so it is not used.
 *
 * IDEMPOTENT. A brain that already exists is reported `already-present` and left ALONE: the
 * seeder never overwrites durable governed state, so a drifted brain is a governance question,
 * not something a re-run silently resets. Order is the loader's order, which puts `brain-chief`
 * first — required by the supervisor self-FK and by "one root per tenant".
 *
 * TENANT. Taken from the principal (`admin.tenantId`), never hardcoded: no tenant context
 * means no tenant operation.
 *
 * PRECONDITION, NOT A PRODUCT. The nine reused roles (`BRAIN_ROLES`) must already be `active`.
 * When they are not, governance refuses and that is what the report says — no brain is
 * invented and no certification is forged to make a happy path work.
 */

export type BrainSeedOutcome = "created" | "already-present" | "refused";

export interface BrainSeedResult {
  readonly agentId: string;
  readonly outcome: BrainSeedOutcome;
  /** The governance violations behind a refusal. Present only for `refused`. */
  readonly violations?: readonly string[];
}

export interface BrainSeedReport {
  readonly results: readonly BrainSeedResult[];
  /** True ONLY when every brain is durably present. An absence is never read as success. */
  readonly complete: boolean;
}

/**
 * The creation facts of a brain row. `depth`, `parentAgentId`, `status`, `createdBy` and the
 * clock are deliberately NOT passed: `createAgent` owns them, and the seed does not get to
 * assert its own lineage.
 */
function specOf(brain: WorkforceAgent): AgentSpec {
  return {
    agentId: brain.agentId,
    kind: brain.kind,
    roleId: brain.roleId,
    roleVersion: brain.roleVersion,
    displayName: brain.displayName,
    departmentId: brain.departmentId,
    supervisorAgentId: brain.supervisorAgentId,
    scope: brain.scope,
    memoryScope: brain.memoryScope,
    policy: brain.policy,
    ...(brain.compute ? { compute: brain.compute } : {}),
    objectives: [...brain.objectives],
    kpis: [...brain.kpis],
  };
}

export async function seedBrains(
  deps: {
    service: Pick<WorkforceService, "createAgent">;
    store: Pick<WorkforceStore, "getAgent">;
    now?: () => string;
  },
  admin: Principal,
): Promise<BrainSeedReport> {
  const tenantId = admin.tenantId;
  const brains = loadBrains({
    tenantId,
    createdBy: { kind: admin.kind, id: admin.id },
    now: (deps.now ?? (() => new Date().toISOString()))(),
  });

  const results: BrainSeedResult[] = [];
  for (const brain of brains) {
    if (await deps.store.getAgent(tenantId, brain.agentId)) {
      results.push({ agentId: brain.agentId, outcome: "already-present" });
      continue;
    }
    try {
      await deps.service.createAgent(admin, specOf(brain));
      results.push({ agentId: brain.agentId, outcome: "created" });
    } catch (error) {
      // Only a GOVERNED refusal becomes a report line (it has already written its own durable
      // denial event). A conflict, a schema error or a database failure is not survivable here.
      if (!(error instanceof WorkforceDeniedError)) throw error;
      results.push({
        agentId: brain.agentId,
        outcome: "refused",
        violations: error.violations,
      });
    }
  }

  return { results, complete: results.every((r) => r.outcome !== "refused") };
}
