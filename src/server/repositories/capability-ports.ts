import type { AgentCapability, Capability, CapabilityStatus } from "@/core/contracts/capability";

export interface CapabilityRepository {
  getById(id: string): Promise<Capability | null>;
  getByKey(key: string): Promise<Capability | null>;
  list(): Promise<Capability[]>;
  create(capability: Capability): Promise<Capability>;
  updateStatus(id: string, status: CapabilityStatus): Promise<Capability | null>;
  /** Supprime une capacité par son id. Retourne `true` si une ligne a été supprimée. */
  delete(id: string): Promise<boolean>;
}

export interface AgentCapabilityRepository {
  listByAgent(agentId: string): Promise<AgentCapability[]>;
  getById(id: string): Promise<AgentCapability | null>;
  grant(agentCapability: AgentCapability): Promise<AgentCapability>;
  revoke(id: string): Promise<boolean>;
}
