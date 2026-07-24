import { agentCapabilitySchema, type AgentCapability } from "@/core/contracts/capability";
import { RepositoryMappingError } from "@/server/database/errors";
import type { AgentCapabilityRepository } from "@/server/repositories/capability-ports";

/**
 * Repository mémoire des assignations capacité ↔ agent.
 */
export class InMemoryAgentCapabilityRepository implements AgentCapabilityRepository {
  private readonly items: AgentCapability[];

  constructor(seed: readonly AgentCapability[] = []) {
    this.items = seed.map((ac) => agentCapabilitySchema.parse(structuredClone(ac)));
  }

  async listByAgent(agentId: string): Promise<AgentCapability[]> {
    return this.items.filter((ac) => ac.agentId === agentId).map((ac) => structuredClone(ac));
  }

  async getById(id: string): Promise<AgentCapability | null> {
    const ac = this.items.find((c) => c.id === id);
    return ac ? structuredClone(ac) : null;
  }

  async grant(agentCapability: AgentCapability): Promise<AgentCapability> {
    if (
      this.items.some(
        (ac) =>
          ac.agentId === agentCapability.agentId &&
          ac.capabilityId === agentCapability.capabilityId,
      )
    ) {
      throw new RepositoryMappingError(
        "agent_capabilities",
        `Duplicate grant: agent=${agentCapability.agentId}, capability=${agentCapability.capabilityId}`,
      );
    }
    const parsed = agentCapabilitySchema.parse(structuredClone(agentCapability));
    this.items.push(parsed);
    return structuredClone(parsed);
  }

  async revoke(id: string): Promise<boolean> {
    const index = this.items.findIndex((ac) => ac.id === id);
    if (index === -1) {
      return false;
    }
    this.items.splice(index, 1);
    return true;
  }
}
