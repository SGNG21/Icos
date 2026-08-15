/**
 * CTX-SUP-E2E — ContextSupervisorBridge.
 *
 * Pont entre le pipeline de contexte (MissionContext) et la frontière
 * Supervisor. Valide, projette, applique les règles de précédence et produit
 * un contexte enrichi pour les tâches Supervisor.
 *
 * ── Schéma ──
 *   MissionContext (artefact de lecture, borné, versionné)
 *      │
 *      ▼
 *   validateAndProject() — validation + projection → SupervisorContextInput
 *      │
 *      ▼
 *   applyPrecedenceRules() — D2 > Conversation, fail-closed sur ambiguïté
 *      │
 *      ▼
 *   SupervisorEnrichedContext (enrichissement de tâche, JAMAIS autorité)
 *
 * ── INVARIANTS DE FRONTIÈRE (spec CTX-SUP-1 §2.1) ──
 *   Context ≠ Permission         Conversation ≠ Authorization
 *   Context ≠ Approval           Supervisor ≠ policy authority   (reste D1)
 *   Context ≠ Authority          Supervisor ≠ approval authority (reste humaine)
 *   Persistence ≠ Authorization  Supervisor ≠ execution authority(reste G1/D4)
 *
 * Le Supervisor NE DOIT PAS interpréter le contexte comme une autorisation :
 * toute action nécessite D1 (policy) + G1 (execution grant).
 */

import type { Mission } from "@/core/mission";

import type { MissionContext } from "./contract";
import {
  supervisorContextInputSchema,
  toSupervisorContextInput,
  type SupervisorContextInput,
} from "./supervisor-input";

// ─────────────────────────────────────
// Types de précédence
// ─────────────────────────────────────

/**
 * Résultat de l'application d'une règle de précédence sur un élément.
 * "accepted" = franchit la frontière ; "stripped" = filtré (non bloquant) ;
 * "conflict" = conflit irréductible → échec.
 */
export type PrecedenceOutcome = "accepted" | "stripped" | "conflict";

/** Raison textuelle expliquant l'application d'une règle. */
export type PrecedenceRuleLabel =
  | "mission_supremacy" // D2 > conversation ; le contexte ne peut contredire la Mission
  | "provenance_valid" // Provenance valide, claim accepté
  | "provenance_untrusted" // Provenance inconnue ou invalide → strip
  | "critical_ambiguity" // Question ouverte critique non résolue → bloquant
  | "non_critical_ambiguity" // Ambiguïté non critique → strip (ne bloque pas)
  | "irrelevant_assumption" // Hypothèse non étayée → strip (ne bloque pas)
  | "memory_unresolvable"; // Référence mémoire non résolvable → strip

/** Enregistrement de précédence : décision + règle appliquée. */
export interface PrecedenceRecord {
  statement: string;
  outcome: PrecedenceOutcome;
  rule: PrecedenceRuleLabel;
}

// ─────────────────────────────────────
// Résultat du bridge
// ─────────────────────────────────────

export type BridgeRefusalCode =
  | "no_context" // Aucun MissionContext disponible
  | "schema_validation" // DTO invalide (autorité, structure brisée)
  | "precedence_conflict" // Contexte contredit la Mission canonique
  | "critical_ambiguity"; // Question ouverte critique non résolue

export type BridgeResult =
  { ok: true; envelope: SupervisorEnrichedContext } | { ok: false; reason: BridgeRefusalCode };

// ─────────────────────────────────────
// Contexte enrichi pour le Supervisor
// ─────────────────────────────────────

/**
 * Enveloppe de contexte enrichi pour le Supervisor.
 *
 * PROPRIÉTÉS :
 * - **Lecture seule** : le Supervisor consomme, ne mute pas.
 * - **Non autoritaire** : aucun champ ne peut être interprété comme permission,
 *   approbation ou grant. Le Supervisor DOIT passer par D1/G1 pour agir.
 * - **Borné** : hérite des bornes de MissionContext → SupervisorContextInput.
 * - **Précédence appliquée** : les éléments filtrés sont documentés dans
 *   `precedenceRecords` à des fins d'audit/débogage.
 */
export interface SupervisorEnrichedContext {
  /** DTO d'entrée Supervisor (figé, strict, non autoritaire). */
  input: SupervisorContextInput;

  /** Enregistrement des décisions de précédence prises. */
  precedenceRecords: ReadonlyArray<PrecedenceRecord>;

  /** Vrai si des ambiguïtés non critiques ont été filtrées. */
  hadStrippedItems: boolean;

  /** Référence au contexte source (pour audit/traçage, jamais autorité). */
  sourceRef: {
    tenantId: string;
    missionId: string;
    version: number;
    builtAt: string;
  };
}

// ─────────────────────────────────────
// Règles de précédence
// ─────────────────────────────────────

/**
 * Règle 1 — MISSION_SUPREMACY
 *
 * Le contexte ne peut pas contredire la Mission canonique (D2).
 * Si `mission.userRequest` et `context.confirmedObjective` divergent de
 * manière incompatible, le pont refuse la livraison (fail-closed).
 *
 * Une divergence est incompatible quand les deux chaînes ne partagent aucun
 * token significatif après nettoyage de base (minuscules, découpage).
 *
 * @returns `conflict` si divergence incompatible, `accepted` sinon.
 */
/** Mots vides français/anglais exclus de la comparaison de précédence. */
const STOPWORDS = new Set([
  "le",
  "la",
  "les",
  "de",
  "du",
  "des",
  "un",
  "une",
  "et",
  "ou",
  "en",
  "au",
  "aux",
  "par",
  "pour",
  "sur",
  "dans",
  "avec",
  "est",
  "sont",
  "ce",
  "cet",
  "cette",
  "ces",
  "qui",
  "que",
  "dont",
  "où",
  "pas",
  "ne",
  "n",
  "à",
  "a",
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "is",
  "are",
  "it",
  "its",
  "be",
  "by",
  "as",
  "was",
  "were",
  "has",
  "have",
  "been",
  "not",
  "no",
]);

export function checkMissionSupremacy(
  contextObjective: string,
  missionUserRequest: string,
): PrecedenceRecord {
  const normalize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !STOPWORDS.has(t));

  const ctxTokens = normalize(contextObjective);
  const reqTokens = normalize(missionUserRequest);
  const hasOverlap = ctxTokens.some((t) => reqTokens.includes(t));

  if (!hasOverlap && ctxTokens.length > 0 && reqTokens.length > 0) {
    return {
      statement: contextObjective,
      outcome: "conflict",
      rule: "mission_supremacy",
    };
  }

  return {
    statement: contextObjective,
    outcome: "accepted",
    rule: "mission_supremacy",
  };
}

/**
 * Règle 2 — CRITICAL_AMBIGUITY
 *
 * Les questions ouvertes dont l'énoncé porte sur un aspect critique de
 * l'exécution (sécurité, intégrité, autorisation, déploiement, production)
 * sont bloquantes. Les autres sont simplement filtrées (stripped).
 */
const CRITICAL_PATTERNS = [
  /sécurit/i,
  /security/i,
  /auth/i,
  /token/i,
  /credential/i,
  /production/i,
  /deploy/i,
  /merge/i,
  /autorisation/i,
  /permission/i,
];

export function classifyQuestionAmbiguity(statement: string): PrecedenceRecord {
  const isCritical = CRITICAL_PATTERNS.some((p) => p.test(statement));
  return {
    statement,
    outcome: isCritical ? "conflict" : "stripped",
    rule: isCritical ? "critical_ambiguity" : "non_critical_ambiguity",
  };
}

/**
 * Règle 3 — UNTRUSTED_PROVENANCE
 *
 * Un claim dont la provenance est absente, vide ou invalide est filtré.
 * Applicable aux assumptions et aux contraintes.
 */
export function checkProvenanceTrust(
  statement: string,
  provenanceRef: string | undefined | null,
): PrecedenceRecord {
  if (!provenanceRef || provenanceRef.trim().length === 0) {
    return {
      statement,
      outcome: "stripped",
      rule: "provenance_untrusted",
    };
  }
  return {
    statement,
    outcome: "accepted",
    rule: "provenance_valid",
  };
}

// ─────────────────────────────────────
// Fonction principale du bridge
// ─────────────────────────────────────

/**
 * Valide, projette et applique les règles de précédence à un MissionContext
 * pour produire un SupervisorEnrichedContext.
 *
 * Cette fonction est :
 * - **PURE** : aucune I/O, aucune horloge, aucun accès réseau/SQL.
 * - **DÉTERMINISTE** : mêmes entrées → même résultat.
 * - **FAIL-CLOSED** : toute ambiguïté critique, conflit ou validation échouée
 *   refuse la livraison plutôt que de deviner.
 * - **NON AUTORITAIRE** : l'enveloppe ne contient ni grant, ni décision allow,
 *   ni approbation, ni secret.
 *
 * @param context - MissionContext canonique (artefact de lecture)
 * @param mission - Mission D2 optionnelle (pour la règle mission_supremacy)
 * @returns BridgeResult — ok:true avec l'enveloppe, ou ok:false avec le code de refus
 */
export function resolveSupervisorContext(context: MissionContext, mission?: Mission): BridgeResult {
  // ── Étape 1 : Projection vers le DTO Supervisor ──
  const dto = toSupervisorContextInput(context);

  // ── Étape 2 : Validation du schéma strict ──
  const parsed = supervisorContextInputSchema.safeParse(dto);
  if (!parsed.success) {
    return { ok: false, reason: "schema_validation" };
  }

  // ── Étape 3 : Règles de précédence ──
  const records: PrecedenceRecord[] = [];
  let hasCriticalFailure = false;
  let hasStripped = false;

  // Helper : n'enregistre que les décisions non-acceptées (stripped/conflict).
  // Les claims acceptés ne produisent pas de record : cela évite que du texte
  // d'assumption injecté (token, credential, instruction) fuie dans le record
  // d'audit du bridge.
  function recordIfNotAccepted(r: PrecedenceRecord): void {
    if (r.outcome !== "accepted") {
      records.push(r);
      if (r.outcome === "conflict") hasCriticalFailure = true;
      if (r.outcome === "stripped") hasStripped = true;
    }
  }

  // 3a — Mission supremacy : contexte objectif vs D2 userRequest
  if (mission) {
    recordIfNotAccepted(checkMissionSupremacy(context.confirmedObjective, mission.userRequest));
  }

  // 3b — Questions ouvertes : classer comme critique ou non
  for (const q of context.openQuestions) {
    recordIfNotAccepted(classifyQuestionAmbiguity(q.statement));
  }

  // 3c — Provenance des contraintes confirmées
  for (const cc of context.confirmedConstraints) {
    recordIfNotAccepted(checkProvenanceTrust(cc.statement, cc.provenance.ref));
  }

  // 3d — Provenance des assumptions
  for (const as of context.assumptions) {
    recordIfNotAccepted(checkProvenanceTrust(as.statement, as.provenance.ref));
  }

  // ── Étape 4 : Fail-closed sur conflit critique ──
  if (hasCriticalFailure) {
    const criticalRecord = records.find((r) => r.outcome === "conflict");
    const reason =
      criticalRecord?.rule === "mission_supremacy" ? "precedence_conflict" : "critical_ambiguity";
    return { ok: false, reason };
  }

  // ── Étape 5 : Enveloppe enrichie ──
  return {
    ok: true,
    envelope: {
      input: dto,
      precedenceRecords: records,
      hadStrippedItems: hasStripped,
      sourceRef: {
        tenantId: context.tenantId,
        missionId: context.missionId,
        version: context.version,
        builtAt: context.builtAt,
      },
    },
  };
}
