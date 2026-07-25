import type { PolicyDecision, PolicyRequest } from "./contract";
import { type PolicyGate } from "./gates/gate";
import { TenantGate } from "./gates/tenant.gate";
import { IDORGate } from "./gates/idor.gate";
import { ClassificationGate } from "./gates/classification.gate";
import { RetentionGate } from "./gates/retention.gate";
import { PermissionGate } from "./gates/permission.gate";
import { RiskGate } from "./gates/risk.gate";
import { ExternalEffectGate } from "./gates/external-effect.gate";

/** Chaîne de gates par défaut pour D1. */
export const DEFAULT_GATES: readonly PolicyGate[] = [
  new TenantGate(),
  new IDORGate(),
  new ClassificationGate(),
  new RetentionGate(),
  new PermissionGate(),
  new RiskGate(),
  new ExternalEffectGate(),
];

/**
 * Moteur de politique D1 (PUR, sans I/O).
 *
 * Applique une chaîne de gates dans l'ordre. La première gate qui produit une
 * décision autre que "next" termine l'évaluation.
 *
 * INVARIANT : si aucune gate ne peut décider, le résultat est DENY (fail-closed).
 */
export class D1PolicyEngine {
  private readonly gates: readonly PolicyGate[];

  constructor(gates: readonly PolicyGate[] = DEFAULT_GATES) {
    this.gates = gates;
  }

  /**
   * Evalue la requête contre toutes les gates.
   * Ordre d'application :
   * 1. Tenant gate
   * 2. IDOR gate
   * 3. Classification gate
   * 4. Retention gate
   * 5. Permission gate
   * 6. Risk gate
   * 7. External effect gate
   */
  decide(request: PolicyRequest): PolicyDecision {
    try {
      for (const gate of this.gates) {
        const result = gate.evaluate(request);
        switch (result.decision) {
          case "deny":
            return {
              outcome: "deny",
              reason: result.reason,
              code: result.code,
            };
          case "require_approval":
            return {
              outcome: "require_approval",
              reason: result.reason,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            };
          // "next" → continuer la chaîne.
        }
      }

      // Toutes les gates ont passé → ALLOW
      return {
        outcome: "allow",
        reason: "Toutes les gates D1 ont passé",
        attestedAt: new Date().toISOString(),
      };
    } catch (error) {
      // Fail-closed : toute erreur interne → DENY
      return {
        outcome: "deny",
        reason: `Erreur interne du moteur de politique : ${error instanceof Error ? error.message : String(error)}`,
        code: "policy_denied",
      };
    }
  }
}

export { type PolicyGate } from "./gates/gate";
