import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";
import { tenantIdSchema } from "@/core/contracts/tenant";

/**
 * CTX-SUP-1 — Contrats du pont Conversation ↔ Supervisor.
 *
 * INVARIANTS DE FRONTIÈRE (voir spec CTX-SUP-1 §2) :
 *   Context ≠ Permission
 *   Context ≠ Approval
 *   Context ≠ Authority
 *   Conversation ≠ Authorization
 *   Session ID ≠ Authorization
 *
 * Aucun schéma de ce fichier ne porte de champ d'autorité (grant, décision
 * allow, approbation matérielle, credential, token). Les objets sont
 * `.strict()` : tout champ superflu — en particulier un champ ressemblant à
 * une autorité — est rejeté.
 */

// ─────────────────────────────────────
// Bornes (data minimization + fail-closed over_budget)
// ─────────────────────────────────────

export const CONTEXT_LIMITS = {
  /** Longueur max d'un énoncé de claim ou d'un tour de conversation. */
  statementMaxLength: 2000,
  /** Longueur max du résumé borné. */
  summaryMaxLength: 4000,
  /** Nombre max de tours de conversation acceptés en entrée. */
  maxTurns: 500,
  /** Nombre max de claims (par catégorie) dans un MissionContext. */
  maxClaims: 200,
  /** Nombre max de références mémoire. */
  maxMemoryReferences: 100,
} as const;

// ─────────────────────────────────────
// Provenance
// ─────────────────────────────────────

/** Origine d'une donnée de contexte : d'où vient l'information. */
export const contextSourceKindSchema = z.enum([
  "user_message",
  "agent_message",
  "mission_record",
  "memory_reference",
]);

export type ContextSourceKind = z.infer<typeof contextSourceKindSchema>;

/**
 * Provenance minimale attachée à chaque donnée dérivée. `ref` est une
 * référence opaque et bornée vers l'origine (id de tour, ref mémoire…),
 * jamais un contenu brut ni un secret.
 */
export const contextProvenanceSchema = z
  .object({
    source: contextSourceKindSchema,
    ref: z.string().min(1).max(256),
    observedAt: isoDateTimeSchema,
  })
  .strict();

export type ContextProvenance = z.infer<typeof contextProvenanceSchema>;

/**
 * Référence mémoire : preuve/évidence uniquement, JAMAIS autorité.
 * `source` est contraint à `memory_reference` — une référence mémoire ne peut
 * pas usurper une autre origine ni devenir un fait confirmé automatiquement.
 */
export const memoryReferenceSchema = contextProvenanceSchema
  .extend({
    source: z.literal("memory_reference"),
  })
  .strict();

export type MemoryReference = z.infer<typeof memoryReferenceSchema>;

// ─────────────────────────────────────
// Épistémologie : fait confirmé ≠ hypothèse ≠ question ouverte
// ─────────────────────────────────────

export const epistemicsSchema = z.enum([
  "confirmed_fact",
  "assumption",
  "open_question",
]);

export type Epistemics = z.infer<typeof epistemicsSchema>;

export const contextClaimSchema = z
  .object({
    id: idSchema,
    statement: z.string().min(1).max(CONTEXT_LIMITS.statementMaxLength),
    epistemics: epistemicsSchema,
    provenance: contextProvenanceSchema,
  })
  .strict();

export type ContextClaim = z.infer<typeof contextClaimSchema>;

// ─────────────────────────────────────
// ConversationContext — ENTRÉE brute, non fiable
// ─────────────────────────────────────

export const conversationRoleSchema = z.enum(["user", "agent"]);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

/**
 * Un tour de dialogue. `confirmed` marque explicitement qu'un humain a
 * confirmé cette information ; à défaut elle reste une hypothèse. Aucune
 * confirmation n'est jamais inférée du contenu (défense prompt injection).
 */
export const conversationTurnSchema = z
  .object({
    id: idSchema,
    role: conversationRoleSchema,
    text: z.string().min(1).max(CONTEXT_LIMITS.statementMaxLength),
    /** Confirmation humaine explicite (jamais déduite du texte). */
    confirmed: z.boolean().default(false),
    /** Marque un objectif confirmé (au plus un tour peut le porter). */
    isObjective: z.boolean().default(false),
    /** Marque une question ouverte non résolue. */
    isOpenQuestion: z.boolean().default(false),
    /** Signale explicitement un conflit avec la Mission canonique (D2). */
    conflictsWithMission: z.boolean().default(false),
    observedAt: isoDateTimeSchema,
  })
  .strict();

export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

/**
 * ConversationContext — entrée du ContextBuilder. Éphémère, non fiable,
 * ne porte aucune autorité. `tenantId` sert au contrôle d'isolation.
 */
export const conversationContextSchema = z
  .object({
    tenantId: tenantIdSchema,
    // Les bornes de budget (maxTurns, maxMemoryReferences) NE sont PAS
    // appliquées ici : le schéma valide seulement la forme structurelle.
    // `buildMissionContext` est l'unique autorité de budget (fail-closed via
    // `over_budget`), afin qu'un dépassement soit un refus explicite et non un
    // `non_serializable_input` ambigu.
    turns: z.array(conversationTurnSchema),
    memoryReferences: z.array(memoryReferenceSchema).default([]),
  })
  .strict();

export type ConversationContext = z.infer<typeof conversationContextSchema>;

// ─────────────────────────────────────
// MissionContext — SORTIE bornée, versionnée, à provenance tracée
// ─────────────────────────────────────

/**
 * MissionContext — artefact de LECTURE. Transporte de l'information, jamais de
 * l'autorité. Immuable une fois émis ; toute évolution crée une nouvelle
 * version (mission-scopée, monotone).
 *
 * `.strict()` garantit qu'aucun champ d'autorité (grant, token, décision
 * allow, approbation matérielle, credential) ne peut être ajouté sans casser
 * le contrat.
 */
export const missionContextSchema = z
  .object({
    tenantId: tenantIdSchema,
    missionId: idSchema,
    version: z.number().int().nonnegative(),
    confirmedObjective: z.string().min(1).max(CONTEXT_LIMITS.statementMaxLength),
    confirmedConstraints: z
      .array(contextClaimSchema)
      .max(CONTEXT_LIMITS.maxClaims)
      .default([]),
    assumptions: z
      .array(contextClaimSchema)
      .max(CONTEXT_LIMITS.maxClaims)
      .default([]),
    openQuestions: z
      .array(contextClaimSchema)
      .max(CONTEXT_LIMITS.maxClaims)
      .default([]),
    boundedSummary: z.string().max(CONTEXT_LIMITS.summaryMaxLength),
    memoryReferences: z
      .array(memoryReferenceSchema)
      .max(CONTEXT_LIMITS.maxMemoryReferences)
      .default([]),
    builtAt: isoDateTimeSchema,
    /** Étiquette du builder (audit/debug), NON authentifiée. */
    builtByLabel: z.string().min(1).max(128),
  })
  .strict();

export type MissionContext = z.infer<typeof missionContextSchema>;

// ─────────────────────────────────────
// Résultat du build — fail-closed
// ─────────────────────────────────────

export const buildRefusalCodeSchema = z.enum([
  "no_confirmed_objective",
  "tenant_mismatch",
  "mission_conflict",
  "unresolved_ambiguity",
  "over_budget",
  "non_serializable_input",
]);

export type BuildRefusalCode = z.infer<typeof buildRefusalCodeSchema>;

export type BuildContextResult =
  | { ok: true; context: MissionContext }
  | { ok: false; reason: BuildRefusalCode };
