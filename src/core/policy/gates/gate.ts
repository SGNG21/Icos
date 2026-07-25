import type { PolicyDenialCode, PolicyRequest } from "../contract";

/**
 * Gate individuelle de la chaîne D1.
 * Chaque gate implémente une règle indépendante.
 */
export interface PolicyGate {
  readonly name: string;
  evaluate(request: PolicyRequest): PolicyGateResult;
}

export type PolicyGateResult =
  | { decision: "next" }
  | { decision: "deny"; code: PolicyDenialCode; reason: string }
  | { decision: "require_approval"; reason: string };
