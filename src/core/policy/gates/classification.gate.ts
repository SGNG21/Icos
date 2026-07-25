import type { PolicyGate, PolicyGateResult } from "./gate";
import type { PolicyRequest } from "../contract";

/**
 * Sensibilité minimale autorisée par niveau d'autorisation.
 * Un acteur avec level < threshold ne peut pas accéder à des resources
 * de niveau supérieur.
 */
const MINIMUM_LEVEL_FOR_SENSITIVITY: Record<string, number> = {
  C0: 0,
  C1: 1,
  C2: 2,
  C3: 3,
};

/**
 * Classification gate : vérifie que l'acteur a le niveau suffisant
 * pour accéder à une resource classifiée.
 *
 * Règle :
 * - C0 → accessible à tout acteur
 * - C1 → authorizationLevel ≥ 1
 * - C2 → authorizationLevel ≥ 2
 * - C3 → authorizationLevel ≥ 3
 * - Pas de classification → pas de restriction (C0 implicite)
 */
export class ClassificationGate implements PolicyGate {
  readonly name = "classification";

  evaluate(request: PolicyRequest): PolicyGateResult {
    const sensitivity = request.resource.sensitivityLevel;
    if (!sensitivity) {
      return { decision: "next" }; // Pas de classification → pas de restriction
    }

    const requiredLevel = MINIMUM_LEVEL_FOR_SENSITIVITY[sensitivity];
    if (requiredLevel === undefined) {
      return { decision: "deny", code: "classification_too_high", reason: `Niveau '${sensitivity}' inconnu` };
    }

    const actorLevel = request.actor.authorizationLevel ?? 0;
    if (actorLevel < requiredLevel) {
      return {
        decision: "deny",
        code: "classification_too_high",
        reason: `Resource classifiée ${sensitivity} necessite niveau ${requiredLevel}, acteur a niveau ${actorLevel}`,
      };
    }

    return { decision: "next" };
  }
}
