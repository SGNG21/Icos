import { agentSchema, type Agent } from "@/core/contracts";
import { compareAgents } from "@/core/ordering";

import type { AgentRepository, AgentScope } from "@/server/repositories/ports";

/**
 * Repository en mémoire des agents (voir avertissement dans
 * `src/server/audit/in-memory-audit-log.ts`). Lecture seule ; travail interne
 * synchrone, exposé derrière un port asynchrone.
 */
export class InMemoryAgentRepository implements AgentRepository {
  private readonly agents: Agent[];

  /** Copie défensive du seed : les constantes importées ne sont jamais partagées. */
  constructor(seed: readonly Agent[]) {
    this.agents = seed.map((agent) => agentSchema.parse(structuredClone(agent)));
  }

  async list(): Promise<Agent[]> {
    return this.agents.map((agent) => structuredClone(agent)).sort(compareAgents);
  }

  async listForScope(scope: AgentScope): Promise<Agent[]> {
    const agents = await this.list();
    return scope.kind === "global"
      ? agents
      : agents.filter((agent) => scope.agentIds.has(agent.id));
  }

  async getById(id: string): Promise<Agent | null> {
    const agent = this.agents.find((candidate) => candidate.id === id);
    return agent ? structuredClone(agent) : null;
  }

  async getByIdForScope(id: string, scope: AgentScope): Promise<Agent | null> {
    if (scope.kind === "linked" && !scope.agentIds.has(id)) {
      return null;
    }

    return this.getById(id);
  }
}
