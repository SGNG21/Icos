import type { Mission } from "@/core/mission";

import {
  conversationContextSchema,
  CONTEXT_LIMITS,
  type BuildContextResult,
  type ContextClaim,
  type ConversationContext,
  type ConversationTurn,
  type MemoryReference,
  type MissionContext,
} from "./contract";

/**
 * CTX-SUP-1 — ContextBuilder (fonction pure, déterministe, fail-closed).
 *
 * Transforme une conversation (non fiable) + une Mission déjà résolue (D2 =
 * source de vérité) en un `MissionContext` borné et à provenance tracée.
 *
 * INVARIANTS :
 * - Ne fabrique JAMAIS de Mission (consomme celle fournie).
 * - Ne crée JAMAIS d'autorité : la sortie ne contient ni grant, ni décision
 *   allow, ni approbation, ni secret.
 * - Fail-closed : toute ambiguïté, conflit ou dépassement de bornes refuse la
 *   construction plutôt que de deviner.
 * - Déterministe : mêmes entrées + même `now` → même sortie.
 */
export interface BuildMissionContextInput {
  conversation: ConversationContext;
  mission: Mission;
  builtByLabel: string;
  /** Injecté pour le déterminisme (aucun accès horloge dans `core`). */
  now: string;
  /** Version cible (mission-scopée, monotone). Défaut : 0. */
  version?: number;
}

/** Dérive un id de claim déterministe à partir de l'id du tour source. */
function claimId(prefix: string, turnId: string): string {
  return `${prefix}-${turnId}`;
}

function toClaim(
  turn: ConversationTurn,
  epistemics: ContextClaim["epistemics"],
  idPrefix: string,
): ContextClaim {
  return {
    id: claimId(idPrefix, turn.id),
    statement: turn.text,
    epistemics,
    provenance: {
      source: turn.role === "user" ? "user_message" : "agent_message",
      ref: turn.id,
      observedAt: turn.observedAt,
    },
  };
}

export function buildMissionContext(input: BuildMissionContextInput): BuildContextResult {
  // 1. Entrée sérialisable et bien formée ? Sinon fail-closed.
  const parsed = conversationContextSchema.safeParse(input.conversation);
  if (!parsed.success) {
    return { ok: false, reason: "non_serializable_input" };
  }
  const conversation = parsed.data;

  // 2. Isolation tenant : la conversation doit appartenir au tenant de la
  //    mission. Aucun rapprochement cross-tenant.
  if (conversation.tenantId !== input.mission.tenantId) {
    return { ok: false, reason: "tenant_mismatch" };
  }

  // 3. Conflit explicite avec la Mission canonique → la Mission gagne toujours.
  if (conversation.turns.some((t) => t.conflictsWithMission)) {
    return { ok: false, reason: "mission_conflict" };
  }

  // 4. Bornes (fail-closed avant toute construction).
  if (conversation.turns.length > CONTEXT_LIMITS.maxTurns) {
    return { ok: false, reason: "over_budget" };
  }

  // 5. Objectif confirmé : uniquement depuis un tour explicitement confirmé et
  //    marqué comme objectif. Jamais inféré. Absent → refus.
  const objectiveTurn = conversation.turns.find((t) => t.isObjective && t.confirmed);
  if (!objectiveTurn) {
    return { ok: false, reason: "no_confirmed_objective" };
  }

  // 6. Classement épistémique de chaque tour restant.
  const confirmedConstraints: ContextClaim[] = [];
  const assumptions: ContextClaim[] = [];
  const openQuestions: ContextClaim[] = [];

  for (const turn of conversation.turns) {
    if (turn.id === objectiveTurn.id) {
      continue;
    }
    if (turn.isOpenQuestion) {
      openQuestions.push(toClaim(turn, "open_question", "oq"));
    } else if (turn.confirmed) {
      confirmedConstraints.push(toClaim(turn, "confirmed_fact", "cc"));
    } else {
      // Tout ce qui n'est pas explicitement confirmé reste une hypothèse.
      assumptions.push(toClaim(turn, "assumption", "as"));
    }
  }

  // 7. Bornes par catégorie.
  if (
    confirmedConstraints.length > CONTEXT_LIMITS.maxClaims ||
    assumptions.length > CONTEXT_LIMITS.maxClaims ||
    openQuestions.length > CONTEXT_LIMITS.maxClaims ||
    conversation.memoryReferences.length > CONTEXT_LIMITS.maxMemoryReferences
  ) {
    return { ok: false, reason: "over_budget" };
  }

  // 8. Résumé borné, déterministe, dérivé du seul objectif confirmé.
  const boundedSummary = objectiveTurn.text.slice(0, CONTEXT_LIMITS.summaryMaxLength);

  // 9. Références mémoire : preuve uniquement (jamais promues en fait).
  const memoryReferences: MemoryReference[] = conversation.memoryReferences;

  const context: MissionContext = {
    tenantId: input.mission.tenantId,
    missionId: input.mission.id,
    version: input.version ?? 0,
    confirmedObjective: objectiveTurn.text,
    confirmedConstraints,
    assumptions,
    openQuestions,
    boundedSummary,
    memoryReferences,
    builtAt: input.now,
    builtByLabel: input.builtByLabel,
  };

  return { ok: true, context };
}
