import { highestRole, type AuthenticatedSession } from "@/core/identity";
import type { AgentScope, HumanAgentLinkRepository } from "@/server/repositories/ports";

export class OperationalAccessService {
  constructor(private readonly links: HumanAgentLinkRepository) {}

  async resolveScope(session: AuthenticatedSession): Promise<AgentScope> {
    const role = highestRole(session.roles);
    if (role === "owner" || role === "admin") {
      return { kind: "global" };
    }

    if (role === "operator" || role === "viewer") {
      return {
        kind: "linked",
        agentIds: await this.links.listAgentIdsForHuman(session.user.id),
      };
    }

    return { kind: "linked", agentIds: new Set() };
  }
}

export function scopeContainsAgent(scope: AgentScope, agentId: string): boolean {
  return scope.kind === "global" || scope.agentIds.has(agentId);
}

export function canCreateTaskInScope(input: {
  scope: AgentScope;
  assignedAgentId?: string;
}): boolean {
  if (input.scope.kind === "global") {
    return true;
  }

  // Unassigned tasks are allowed for any scope — the restriction only
  // applies when a specific agent is targeted.
  if (input.assignedAgentId === undefined) {
    return true;
  }

  return scopeContainsAgent(input.scope, input.assignedAgentId);
}
