import type {
  TaskExecutionResult,
  Artifact,
  Evidence,
  Finding,
  WorkerKind,
} from "@/core/contracts";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type {
  ReviewDecisionRecord,
  ReviewDecision,
  RequestedChange,
} from "@/core/contracts/review";

/**
 * Entrée complète pour le reviewer.
 * Contient tout le contexte nécessaire pour juger indépendamment.
 */
export interface ReviewInput {
  /** Contexte mission */
  mission: Mission;
  missionTask: MissionTask;
  /** Tâche canonique */
  task: {
    id: string;
    title: string;
    description: string | undefined;
  };
  /** Résultat d'exécution canonique */
  executionResult: TaskExecutionResult;
  /** Artefacts produits */
  artifacts: readonly Artifact[];
  /** Preuves d'exécution */
  evidence: readonly Evidence[];
  /** Findings normalisés (gates, healer, etc.) */
  findings: readonly Finding[];
  /** Contexte politique/risque (futur) */
  policyContext?: Record<string, unknown>;
  /** Annulation coopérative sur perte de propriété du runner. */
  signal?: AbortSignal;
}

/**
 * Résultat d'une revue déterministe (règles dures).
 * Si `blockingDecision` est présent, le LLM reviewer NE PEUT PAS le déclasser.
 */
export interface DeterministicReviewResult {
  blockingDecision: ReviewDecisionRecord | null;
  /** Raisons qui ont déclenché la décision dure */
  hardReasons: string[];
  /** La revue doit-elle continuer vers le LLM ? */
  proceedToLlm: boolean;
}

/**
 * Port abstrait pour un reviewer (provider-indépendant).
 * Implémentations : FakeReviewer (tests), OmniRouteReviewer (prod), etc.
 */
export interface ReviewerPort {
  /**
   * Effectue une revue LLM du résultat.
   * NE DOIT JAMAIS déclasser une BLOCK/ESCALATE_TO_HUMAN déterministe.
   */
  review(input: ReviewInput): Promise<{
    decision: ReviewDecision;
    reasons: string[];
    requestedChanges?: RequestedChange[];
    confidence?: number;
    providerMetadata?: {
      provider: string;
      model: string;
      temperature?: number;
      promptVersion?: string;
    };
  }>;
}

/**
 * Service de revue combinant règles déterministes + LLM.
 */
export interface ReviewerService {
  /**
   * Effectue la revue complète (deterministic + LLM si applicable).
   * Retourne la décision canonique persistable.
   */
  review(input: ReviewInput): Promise<ReviewDecisionRecord>;
}

export type { ReviewDecision, ReviewDecisionRecord, RequestedChange, WorkerKind };
export type { ReviewDecisionRepository } from "./review-decision-repository";
