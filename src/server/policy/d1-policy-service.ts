import { D1PolicyEngine, type PolicyRequest, type PolicyDecision } from "@/core/policy";
import type { D1PolicyPort } from "./ports";

/**
 * Service D1 Policy — wrapper du moteur PUR dans le container.
 * Les permissions sont fournies par le caller dans `request.actor.roles`.
 */
export class D1PolicyService implements D1PolicyPort {
  private readonly engine: D1PolicyEngine;

  constructor(engine?: D1PolicyEngine) {
    this.engine = engine ?? new D1PolicyEngine();
  }

  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    return this.engine.decide(request);
  }
}
