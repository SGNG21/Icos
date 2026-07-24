import {
  capabilitySchema,
  type Capability,
  type CapabilityStatus,
} from "@/core/contracts/capability";
import { compareCapabilities } from "@/core/ordering";
import { RepositoryMappingError } from "@/server/database/errors";
import type { CapabilityRepository } from "@/server/repositories/capability-ports";

/**
 * Repository mémoire des capacités.
 */
export class InMemoryCapabilityRepository implements CapabilityRepository {
  private readonly capabilities: Capability[];

  constructor(seed: readonly Capability[] = []) {
    this.capabilities = seed.map((cap) => capabilitySchema.parse(structuredClone(cap)));
  }

  async list(): Promise<Capability[]> {
    return this.capabilities
      .map((cap) => structuredClone(cap))
      .sort(compareCapabilities);
  }

  async getById(id: string): Promise<Capability | null> {
    const cap = this.capabilities.find((c) => c.id === id);
    return cap ? structuredClone(cap) : null;
  }

  async getByKey(key: string): Promise<Capability | null> {
    const cap = this.capabilities.find((c) => c.key === key);
    return cap ? structuredClone(cap) : null;
  }

  async create(capability: Capability): Promise<Capability> {
    if (this.capabilities.some((c) => c.id === capability.id)) {
      throw new RepositoryMappingError("capabilities", `Duplicate id: ${capability.id}`);
    }
    if (this.capabilities.some((c) => c.key === capability.key)) {
      throw new RepositoryMappingError("capabilities", `Duplicate key: ${capability.key}`);
    }
    const parsed = capabilitySchema.parse(structuredClone(capability));
    this.capabilities.push(parsed);
    return structuredClone(parsed);
  }

  async updateStatus(id: string, status: CapabilityStatus): Promise<Capability | null> {
    const index = this.capabilities.findIndex((c) => c.id === id);
    if (index === -1) {
      return null;
    }
    const updated = {
      ...this.capabilities[index],
      status,
      updatedAt: new Date().toISOString(),
    };
    const parsed = capabilitySchema.parse(updated);
    this.capabilities[index] = parsed;
    return structuredClone(parsed);
  }
}
