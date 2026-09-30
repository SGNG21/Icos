import type { MemoryVisibility, WorkforceAgent } from "./contracts";
import {
  isActive,
  isGrantLive,
  namespaceAllowed,
  policyWithin,
  scopeCovers,
  type GovernanceViolation,
} from "./governance";

/**
 * EFFECTIVE AUTHORITY across the supervision chain (decision 0057 §integration). Pure.
 *
 * An agent's stored policy is what a human GAVE it; its effective authority is that, narrowed
 * by every ancestor as they are NOW. Revoking a grant, narrowing a scope or blocking a
 * supervisor therefore takes effect for the whole subtree at the next check, without
 * rewriting descendants. The Tool Gateway (tools) and the Cognitive Runtime (memory) ask
 * these questions; they own execution and storage, the workforce owns the answer.
 *
 * `chain` is the agent first, then its supervisor, up to the root.
 */

export type AuthorityReason =
  | "AGENT_UNKNOWN"
  | "AGENT_NOT_ACTIVE"
  | "ANCESTOR_NOT_ACTIVE"
  | "CHAIN_BROKEN"
  | "NOT_GRANTED"
  | "ACTION_NOT_GRANTED"
  | "SCOPE_ESCAPE"
  | "MISSION_MISMATCH"
  | "NAMESPACE_NOT_ALLOWED"
  | "VISIBILITY_TOO_BROAD"
  | "RETENTION_TOO_LONG"
  | GovernanceViolation;

/** Resolves agent → root. A missing link or a cycle breaks the chain (fail closed). */
export function supervisionChain(
  agentId: string,
  agents: readonly WorkforceAgent[],
): { chain: WorkforceAgent[]; broken: boolean } {
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const chain: WorkforceAgent[] = [];
  let current = byId.get(agentId);
  while (current) {
    if (chain.some((a) => a.agentId === current!.agentId)) return { chain, broken: true };
    chain.push(current);
    if (current.supervisorAgentId === null) return { chain, broken: false };
    current = byId.get(current.supervisorAgentId);
  }
  return { chain, broken: true };
}

function chainReasons(
  chain: readonly WorkforceAgent[],
  broken: boolean,
  now: string,
): AuthorityReason[] {
  if (chain.length === 0) return ["AGENT_UNKNOWN"];
  const r: AuthorityReason[] = [];
  if (broken) r.push("CHAIN_BROKEN");
  if (!isActive(chain[0], now)) r.push("AGENT_NOT_ACTIVE");
  if (chain.slice(1).some((a) => !isActive(a, now))) r.push("ANCESTOR_NOT_ACTIVE");
  return r;
}

const covered = (
  chain: readonly WorkforceAgent[],
  work: { clientId?: string; projectId?: string },
) => chain.every((a) => scopeCovers(a.scope, work));

/* ------------------------------------------------------------------------------ tool grants */

export interface ToolGrantQuery {
  toolId: string;
  action: string;
  clientId?: string;
  projectId?: string;
  missionId?: string;
}

export interface ToolGrantDecision {
  granted: boolean;
  reasons: AuthorityReason[];
  /** The agent's grant that would authorise the action (provenance for the gateway's audit). */
  grant?: {
    toolId: string;
    actions: string[];
    grantedBy: string;
    delegatedBy?: string;
    expiresAt?: string;
  };
  /** Cache key: any policy change on the chain changes it; a gateway must not cache past it. */
  chainVersion: string;
  evaluatedAt: string;
}

/**
 * "Is agent X currently granted action Y on tool T in scope Z?" A role or skill is never
 * consulted: only live grants, re-contained link by link up to the root.
 */
export function evaluateToolGrant(
  chainResult: { chain: WorkforceAgent[]; broken: boolean },
  q: ToolGrantQuery,
  now: string,
): ToolGrantDecision {
  const { chain, broken } = chainResult;
  const reasons = chainReasons(chain, broken, now);
  const chainVersion = chain.map((a) => `${a.agentId}@${a.version}`).join(">");
  if (chain.length === 0) return { granted: false, reasons, chainVersion, evaluatedAt: now };
  const agent = chain[0];

  const live = agent.policy.toolGrants.filter((g) => g.toolId === q.toolId && isGrantLive(g, now));
  const match = live.find((g) => g.actions.includes("*") || g.actions.includes(q.action));
  if (live.length === 0) reasons.push("NOT_GRANTED");
  else if (!match) reasons.push("ACTION_NOT_GRANTED");

  // Drift: each link's grants for THIS tool must still sit inside its supervisor's.
  const onlyTool = (a: WorkforceAgent) => ({
    ...a.policy,
    toolGrants: a.policy.toolGrants.filter((g) => g.toolId === q.toolId),
  });
  for (let i = 0; i + 1 < chain.length; i++) {
    const drift = policyWithin(onlyTool(chain[i]), onlyTool(chain[i + 1]), now).filter(
      (v) => v === "TOOL_NOT_HELD_BY_PARENT",
    );
    reasons.push(...drift);
    // Autonomy drift: an agent now above an ancestor's autonomy is not trusted with tools.
    if (chain[i].policy.autonomyLevel > chain[i + 1].policy.autonomyLevel) {
      reasons.push("AUTONOMY_EXCEEDS_PARENT");
    }
  }
  if (!covered(chain, q)) reasons.push("SCOPE_ESCAPE");
  if (agent.missionId && q.missionId !== agent.missionId) reasons.push("MISSION_MISMATCH");

  const unique = [...new Set(reasons)];
  return {
    granted: unique.length === 0,
    reasons: unique,
    ...(match
      ? {
          grant: {
            toolId: match.toolId,
            actions: [...match.actions],
            grantedBy: match.grantedBy.id,
            ...(match.delegatedBy ? { delegatedBy: match.delegatedBy } : {}),
            ...(match.expiresAt ? { expiresAt: match.expiresAt } : {}),
          },
        }
      : {}),
    chainVersion,
    evaluatedAt: now,
  };
}

/* ------------------------------------------------------------------------------ memory scope */

const VISIBILITY: readonly MemoryVisibility[] = ["private", "restricted", "tenant"];

export interface EffectiveMemoryScope {
  agentId: string;
  tenantId: string;
  /** false: the chain is broken or not active — the memory layer must refuse everything. */
  active: boolean;
  reasons: AuthorityReason[];
  missionId?: string;
  clientIds: string[];
  projectIds: string[];
  read: string[];
  write: string[];
  maxVisibility: MemoryVisibility;
  retentionDays?: number;
  expiresAt?: string;
  chainVersion: string;
}

/** The agent's memory authority narrowed by every ancestor as they are now. */
export function effectiveMemoryScope(
  chainResult: { chain: WorkforceAgent[]; broken: boolean },
  now: string,
): EffectiveMemoryScope | null {
  const { chain, broken } = chainResult;
  if (chain.length === 0) return null;
  const [agent, ...ancestors] = chain;
  const reasons = chainReasons(chain, broken, now);
  const within = (ns: string, pick: (a: WorkforceAgent) => readonly string[]) =>
    ancestors.every((a) => namespaceAllowed(ns, pick(a)));
  // An id (or `*`) survives only if every ancestor holds it (or holds `*`).
  const listCovered = (ids: readonly string[], key: "clientIds" | "projectIds") =>
    ids.filter((id) =>
      ancestors.every((a) => a.scope[key].includes("*") || a.scope[key].includes(id)),
    );
  const retention = chain
    .map((a) => a.memoryScope.retentionDays)
    .filter((d): d is number => d !== undefined);
  const expiries = chain.map((a) => a.expiresAt).filter((e): e is string => e !== undefined);
  return {
    agentId: agent.agentId,
    tenantId: agent.tenantId,
    active: reasons.length === 0,
    reasons,
    ...(agent.missionId ? { missionId: agent.missionId } : {}),
    clientIds: listCovered(agent.scope.clientIds, "clientIds"),
    projectIds: listCovered(agent.scope.projectIds, "projectIds"),
    read: agent.memoryScope.read.filter((ns) => within(ns, (a) => a.memoryScope.read)),
    write: agent.memoryScope.write.filter((ns) => within(ns, (a) => a.memoryScope.write)),
    maxVisibility:
      VISIBILITY[Math.min(...chain.map((a) => VISIBILITY.indexOf(a.memoryScope.maxVisibility)))],
    ...(retention.length > 0 ? { retentionDays: Math.min(...retention) } : {}),
    ...(expiries.length > 0
      ? { expiresAt: expiries.reduce((m, e) => (Date.parse(e) < Date.parse(m) ? e : m)) }
      : {}),
    chainVersion: chain.map((a) => `${a.agentId}@${a.version}`).join(">"),
  };
}

export interface MemoryAccessQuery {
  namespace: string;
  mode: "read" | "write";
  visibility?: MemoryVisibility;
  retentionDays?: number;
  clientId?: string;
  projectId?: string;
  missionId?: string;
}

export function checkMemoryAccess(
  scope: EffectiveMemoryScope | null,
  q: MemoryAccessQuery,
): { allowed: boolean; reasons: AuthorityReason[] } {
  if (!scope) return { allowed: false, reasons: ["AGENT_UNKNOWN"] };
  const r: AuthorityReason[] = [...scope.reasons];
  if (!namespaceAllowed(q.namespace, q.mode === "read" ? scope.read : scope.write)) {
    r.push("NAMESPACE_NOT_ALLOWED");
  }
  if (q.visibility && VISIBILITY.indexOf(q.visibility) > VISIBILITY.indexOf(scope.maxVisibility)) {
    r.push("VISIBILITY_TOO_BROAD");
  }
  if (
    q.mode === "write" &&
    scope.retentionDays !== undefined &&
    (q.retentionDays === undefined || q.retentionDays > scope.retentionDays)
  ) {
    r.push("RETENTION_TOO_LONG");
  }
  if (!scopeCovers({ clientIds: scope.clientIds, projectIds: scope.projectIds }, q))
    r.push("SCOPE_ESCAPE");
  if (scope.missionId && q.missionId !== scope.missionId) r.push("MISSION_MISMATCH");
  const reasons = [...new Set(r)];
  return { allowed: reasons.length === 0, reasons };
}
