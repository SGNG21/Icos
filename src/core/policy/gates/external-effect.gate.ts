import type { PolicyGate, PolicyGateResult } from "./gate";
import type { PolicyRequest } from "../contract";

/**
 * External effect gate : toute action produisant un effet externe
 * (mutation outside ICOS) nécessite une approbation.
 */
export class ExternalEffectGate implements PolicyGate {
  readonly name = "external_effect";

  evaluate(request: PolicyRequest): PolicyGateResult {
    if (!request.hasExternalEffect) {
      return { decision: "next" };
    }

    // Les actions read_only avec effet externe ne sont pas concernées
    if (request.risk === "read_only") {
      return { decision: "next" };
    }

    return {
      decision: "require_approval",
      reason: "Mutation externe necessite approbation humaine",
    };
  }
}
