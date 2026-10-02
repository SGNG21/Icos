import { MODEL_FAMILIES } from "@/core/workers/compute-routing";

import brainsData from "./bootstrap/brains.json";
import { loadWorkforceBootstrap } from "./bootstrap";
import { workforceAgentSchema, type ActorRef, type WorkforceAgent } from "./contracts";
import { exceedsAllocation, memoryScopeWithin, policyWithin, scopeWithin } from "./governance";

/**
 * THE 12 CANONICAL BRAINS — a SEED, not a second registry.
 *
 * A brain is a durable cognitive IDENTITY: one `workforce_agents` row of kind `DURABLE_AGENT`,
 * cheap and persistent. It is NOT a running process and NOT an always-on model session:
 * execution instances are ephemeral (`EPHEMERAL_SPECIALIST` / `EXECUTION_WORKER`, created per
 * mission). There is no brain table, no brain status and no brain authority — every field below
 * already had a home in `workforceAgentSchema` / `agentPolicySchema` and uses it.
 *
 * Roles are REUSED from `bootstrap/roles.json`; a brain restates no capability (the role's
 * skills are the single source) and no role is invented here. Mapping, and why:
 *   Chief      ICOS_CENTRAL         the root orchestrator role
 *   Planner    OPERATIONS_MANAGER   the only role whose skill carries the `planning` capability
 *   Architect  SOFTWARE_ARCHITECT
 *   Builder    FULLSTACK_ENGINEER
 *   Reviewer   INDEPENDENT_REVIEWER
 *   Recovery   FULLSTACK_ENGINEER   a repair IS a code change (same competence as Builder)
 *   Research   RESEARCHER
 *   Business   SALES_DIRECTOR
 *   Delivery   DEVOPS_ENGINEER      releasing accepted work
 *   Growth     SEO_SPECIALIST
 *   Memory     RESEARCHER           nearest existing role (RESEARCH = research + synthesis)
 *   Evolution  FULLSTACK_ENGINEER   self-improvement ships as ordinary reviewable code
 * Memory and Evolution have no dedicated role template; see DELIBERATE_LIMITS in the lane
 * report. Adding one is a role certification, not a seed.
 *
 * AUTHORITY: a seed is data, so it confers NOTHING. Every brain ships with no tool grant (a
 * grant comes from a human, `toolGrantSchema`), a zero money budget and an EMPTY work scope —
 * fail closed. Autonomy stays under the role's `autonomyCeiling`, Evolution never above
 * Builder, and no brain can raise its own authority (`evaluatePolicyChange` denies
 * SELF_MODIFICATION and demands a human admin).
 *
 * Model choice stays with OmniRoute (decision 0057): preferred/fallback compute is recorded
 * ONLY as the ordered, non-binding `compute.modelHints`, most preferred first, and never as
 * identity or as a gate.
 */

/** Deterministic ids: idempotent by `agentId`, which is the table's key with `tenantId`. */
export const CHIEF_BRAIN_ID = "brain-chief";
export const BUILDER_BRAIN_ID = "brain-builder";
export const EVOLUTION_BRAIN_ID = "brain-evolution";

/** Load order: a supervisor always precedes its reports (the FK needs that). */
export const BRAIN_IDS: readonly string[] = brainsData.map((b) => b.agentId);

export interface BrainSeedContext {
  /** No tenant context -> no tenant operation: the caller supplies the tenant. */
  tenantId: string;
  /** The human admin seeding them. Data creates nobody; creation stays a governed act. */
  createdBy: ActorRef;
  /** Clock as data. */
  now: string;
}

/** `$tenant` in a memory namespace becomes the caller's tenant root. */
function resolveNamespaces(namespaces: readonly string[], tenantId: string): string[] {
  return namespaces.map((n) => n.replace("$tenant", `tenant/${tenantId}`));
}

/**
 * The 12 brains as complete, validated `WorkforceAgent` rows. Pure: no I/O, no DB, no clock.
 * Throws on any inconsistency — a seed that does not validate never becomes a brain.
 */
export function loadBrains(ctx: BrainSeedContext): WorkforceAgent[] {
  const { roles, departments, bounds } = loadWorkforceBootstrap();
  const deptIds = new Set(departments.map((d) => d.departmentId));
  const families: readonly string[] = MODEL_FAMILIES;

  const brains = brainsData.map((entry) =>
    workforceAgentSchema.parse({
      ...entry,
      tenantId: ctx.tenantId,
      memoryScope: {
        ...entry.memoryScope,
        read: resolveNamespaces(entry.memoryScope.read, ctx.tenantId),
        write: resolveNamespaces(entry.memoryScope.write, ctx.tenantId),
      },
      createdBy: ctx.createdBy,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      version: 1,
    }),
  );

  const fail = (id: string, why: string): never => {
    throw new Error(`brains: ${id} ${why}`);
  };
  if (new Set(brains.map((b) => b.agentId)).size !== brains.length) {
    throw new Error("brains: agentId dupliqué");
  }
  if (brains.filter((b) => b.supervisorAgentId === null).length !== 1) {
    throw new Error("brains: une seule racine attendue");
  }
  const root = brains.find((b) => b.supervisorAgentId === null)!;
  if (brains.length > bounds.maxAgents) throw new Error("brains: au-delà de maxAgents");

  const seen = new Set<string>();
  for (const b of brains) {
    const role = roles.find((r) => r.roleId === b.roleId && r.version === b.roleVersion);
    if (!role) fail(b.agentId, `-> rôle inconnu ${b.roleId}@${b.roleVersion}`);
    else {
      if (!role.agentKinds.includes("DURABLE_AGENT")) fail(b.agentId, "-> rôle non durable");
      if (b.policy.autonomyLevel > role.autonomyCeiling) {
        fail(b.agentId, "-> autonomie au-dessus du plafond du rôle");
      }
    }
    if (b.departmentId !== null && !deptIds.has(b.departmentId)) {
      fail(b.agentId, `-> département inconnu ${b.departmentId}`);
    }
    // A seed is not a human: it grants no tool and no money.
    if (b.policy.toolGrants.length > 0 || b.policy.budget.financialCents !== 0) {
      fail(b.agentId, "-> un seed ne confère ni outil ni budget financier");
    }
    if (b.depth > bounds.maxDepth) fail(b.agentId, "-> profondeur au-delà de maxDepth");
    if (b.policy.bounds.maxConcurrentAssignments > bounds.maxConcurrentAssignmentsPerAgent) {
      fail(b.agentId, "-> concurrence au-delà de la borne organisationnelle");
    }
    // `namespacesWithin` compares namespaces as prefixes: a `..` segment would look contained.
    if ([...b.memoryScope.read, ...b.memoryScope.write].some((n) => n.split("/").includes(".."))) {
      fail(b.agentId, "-> segment `..` interdit dans un namespace mémoire");
    }
    for (const hint of b.compute?.modelHints ?? []) {
      if (!families.includes(hint)) fail(b.agentId, `-> famille de modèle inconnue ${hint}`);
    }
    if (b.agentId !== root.agentId) {
      if (b.supervisorAgentId !== root.agentId || !seen.has(b.supervisorAgentId!)) {
        fail(b.agentId, "-> superviseur absent ou déclaré après lui");
      }
      const violations = policyWithin(b.policy, root.policy, ctx.now);
      if (violations.length > 0) fail(b.agentId, `-> ${violations.join(", ")}`);
      if (exceedsAllocation(b.policy, root, brains, b.agentId, ctx.now)) {
        fail(b.agentId, "-> BUDGET_EXCEEDS_PARENT (allocation des frères)");
      }
      if (!scopeWithin(b.scope, root.scope)) fail(b.agentId, "-> SCOPE_ESCAPE");
      if (!memoryScopeWithin(b.memoryScope, root.memoryScope)) {
        fail(b.agentId, "-> MEMORY_SCOPE_ESCAPE");
      }
    }
    seen.add(b.agentId);
  }

  const builder = brains.find((b) => b.agentId === BUILDER_BRAIN_ID);
  const evolution = brains.find((b) => b.agentId === EVOLUTION_BRAIN_ID);
  if (!builder || !evolution) throw new Error("brains: Builder et Evolution sont obligatoires");
  if (evolution.policy.autonomyLevel > builder.policy.autonomyLevel) {
    fail(EVOLUTION_BRAIN_ID, "-> ne peut pas dépasser Builder");
  }
  return brains;
}
