import { agentSchema, type Agent } from "@/core/contracts";

import type { AgentService } from "../ports";

/**
 * Implémentation temporaire en mémoire (voir avertissement dans
 * `src/server/audit/in-memory-audit-log.ts`). Lecture seule : le référentiel
 * des agents ne se modifie pas pendant le Lot 1A.
 */
export class InMemoryAgentService implements AgentService {
  private readonly agents: Agent[];

  /** Copie défensive du seed : les constantes importées ne sont jamais partagées. */
  constructor(seed: readonly Agent[]) {
    this.agents = seed.map((agent) => agentSchema.parse(structuredClone(agent)));
  }

  list(): readonly Agent[] {
    return this.agents.map((agent) => structuredClone(agent));
  }

  getById(id: string): Agent | undefined {
    const agent = this.agents.find((candidate) => candidate.id === id);
    return agent ? structuredClone(agent) : undefined;
  }
}
