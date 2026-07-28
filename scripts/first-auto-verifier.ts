import type { TaskDag } from "@/core/supervisor";
import { isDagSuccessfullyCompleted } from "@/core/supervisor";

export interface FirstAutoFinalState {
  executionStatus: "SUCCEEDED" | "FAILED" | "PARTIAL" | "WAITING_FOR_HUMAN";
  finalDag: TaskDag | null;
  allGatesPassed: boolean;
}

/**
 * Validateur final FIRST-AUTO, strictement en lecture seule.
 *
 * Le statut projeté du Supervisor ne suffit pas : le DAG persisté et chacun de
 * ses nœuds requis doivent exprimer le même succès canonique.
 */
export function isFirstAutoFinalStateSuccessful(state: FirstAutoFinalState): boolean {
  return (
    state.executionStatus === "SUCCEEDED" &&
    state.allGatesPassed &&
    state.finalDag !== null &&
    isDagSuccessfullyCompleted(state.finalDag)
  );
}
