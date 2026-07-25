import type { PolicyDecision, PolicyRequest } from "@/core/policy/contract";

/**
 * Port de politique D1 — point d'entrée unique pour les décisions d'autorisation
 * contextuelle dans le container.
 */
export interface D1PolicyPort {
  decide(request: PolicyRequest): Promise<PolicyDecision>;
}
