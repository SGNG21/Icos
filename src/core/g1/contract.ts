import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";
import { sensitivityLevelSchema } from "@/core/contracts/tenant";

// ─────────────────────────────────────
// IdempotencyKey
// ─────────────────────────────────────

/**
 * Clé d'idempotence déterministe.
 *
 * Dérivée des attributs canoniques de l'invocation :
 * tenant, principal, mission, run, toolId, operation, resource, arguments.
 *
 * INVARIANT : AttemptNumber ≠ IdempotencyKey.
 * Un retry technique conserve la même identité métier d'idempotence.
 */
export const idempotencyKeySchema = z.string().min(1).max(512);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

// ─────────────────────────────────────
// requestHash
// ─────────────────────────────────────

/**
 * Empreinte SHA-256 hexadécimale de l'invocation canonique.
 *
 * Couvre : tenant, principal, toolId, toolDefinitionHash/version,
 * capability, operation, resource, arguments canoniques, effet externe.
 *
 * INVARIANT : Toute divergence entre deux requestHash du même cycle de
 * vie → FAIL CLOSED (IDEMPOTENCY_CONFLICT).
 */
export const requestHashSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
export type RequestHash = z.infer<typeof requestHashSchema>;

// ─────────────────────────────────────
// Policy Provenance
// ─────────────────────────────────────

export const policyProvenanceSchema = z.object({
  /** Référence à la politique D1 ayant autorisé le grant. */
  policyId: z.string().min(1),
  /** Décision D1 ayant mené au grant. */
  decision: z.enum(["allow"]),
  /** Horodatage de la décision. */
  decidedAt: isoDateTimeSchema,
  /** Raison fournie par D1. */
  reason: z.string().optional(),
});
export type PolicyProvenance = z.infer<typeof policyProvenanceSchema>;

// ─────────────────────────────────────
// Credential / Network / Isolation Requirements
// ─────────────────────────────────────

export const credentialRequirementSchema = z.object({
  key: z.string().min(1),
  description: z.string().optional(),
});
export type CredentialRequirement = z.infer<typeof credentialRequirementSchema>;

export const networkRequirementSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().nonnegative().optional(),
  protocol: z.enum(["http", "https", "tcp"]),
});
export type NetworkRequirement = z.infer<typeof networkRequirementSchema>;

export const isolationRequirementSchema = z.object({
  filesystem: z.boolean(),
  network: z.boolean(),
  process: z.boolean(),
});

export const defaultIsolationRequirement = {
  filesystem: true,
  network: false,
  process: true,
} as const;
export type IsolationRequirement = z.infer<typeof isolationRequirementSchema>;

// ─────────────────────────────────────
// ExecutionGrant
// ─────────────────────────────────────

/**
 * ExecutionGrant signifie : "cette invocation précise est actuellement
 * autorisée".
 *
 * INVARIANTS :
 * - Lié à un tenant, principal, requestHash, toolDefinitionHash.
 * - TTL court (expiresAt).
 * - Usage unique : consummation atomique via consumedAt.
 * - Aucun grant émis pour DENY ou REQUIRE_APPROVAL non résolu.
 */
export const executionGrantSchema = z.object({
  /** Identifiant unique du grant. */
  id: idSchema,
  /** Locataire propriétaire du grant. */
  tenantId: z.string().min(1),
  /** Acteur demandeur (agent identifié). */
  principalId: z.string().min(1),
  /** Mission propriétaire. */
  missionId: z.string().min(1),
  /** Run ID. */
  runId: z.string().min(1),
  /** Identifiant de l'outil invoqué. */
  toolId: z.string().min(1),
  /** Empreinte de la définition d'outil. */
  toolDefinitionHash: z.string().min(1),
  /** Version de l'outil (optionnelle). */
  toolVersion: z.string().optional(),
  /** Capacité requise pour l'invocation. */
  capability: z.string().min(1),
  /** Opération invoquée. */
  operation: z.string().min(1),
  /** Ressource cible. */
  resource: z.string().min(1),
  /** Empreinte de la requête canonique. */
  requestHash: requestHashSchema,
  /** Clé d'idempotence liée. */
  idempotencyKey: idempotencyKeySchema,
  /** Provenance de la politique ayant autorisé. */
  policyProvenance: policyProvenanceSchema,
  /** Exigences de credentials. */
  credentialRequirements: z.array(credentialRequirementSchema).default([]),
  /** Exigences réseau. */
  networkRequirements: z.array(networkRequirementSchema).default([]),
  /** Exigences d'isolation. */
  isolationRequirements: isolationRequirementSchema.default(defaultIsolationRequirement),
  /** Date d'émission. */
  issuedAt: isoDateTimeSchema,
  /** Date d'expiration (TTL court). */
  expiresAt: isoDateTimeSchema,
  /**
   * Date de consommation (usage unique).
   * null = non consommé, Date = consommé.
   */
  consumedAt: isoDateTimeSchema.nullable().default(null),
});

export type ExecutionGrant = z.infer<typeof executionGrantSchema>;

// ─────────────────────────────────────
// Grant Consumption State
// ─────────────────────────────────────

export const grantConsumptionStatusSchema = z.enum([
  "AVAILABLE",  // Non consommé, dans sa fenêtre de validité
  "CONSUMED",   // Déjà utilisé (single-use)
  "EXPIRED",    // expiresAt dépassé sans consommation
]);

export type GrantConsumptionStatus = z.infer<typeof grantConsumptionStatusSchema>;

// ─────────────────────────────────────
// Idempotency States
// ─────────────────────────────────────

export const idempotencyStateSchema = z.enum([
  "RESERVED",
  "EXECUTING",
  "COMPLETED",
  "FAILED_SAFE",
  "UNKNOWN",
]);

export type IdempotencyState = z.infer<typeof idempotencyStateSchema>;

export const TERMINAL_IDEMPOTENCY_STATES: readonly IdempotencyState[] = [
  "COMPLETED",
  "FAILED_SAFE",
  "UNKNOWN",
];

/**
 * États d'idempotence.
 *
 * Machine d'état :
 * RESERVED ──→ EXECUTING ──→ COMPLETED
 *                ├──→ FAILED_SAFE
 *                └──→ UNKNOWN (stale EXECUTING)
 *
 * Règles :
 * - RESERVED stale : peut être repris.
 * - EXECUTING stale → UNKNOWN.
 * - UNKNOWN : JAMAIS de rejeu automatique.
 * - COMPLETED : rejeu idempotent (même résultat).
 * - FAILED_SAFE : retry possible (effet non durable).
 */
export const idempotencyEntrySchema = z.object({
  /** Clé d'idempotence (déterministe). */
  idempotencyKey: idempotencyKeySchema,
  /** État courant. */
  state: idempotencyStateSchema,
  /** Empreinte de la requête au moment de la réservation. */
  requestHash: requestHashSchema,
  /** Locataire propriétaire. */
  tenantId: z.string().min(1),
  /** Acteur principal. */
  principalId: z.string().min(1),
  /** Mission propriétaire. */
  missionId: z.string().min(1),
  /** Run ID. */
  runId: z.string().min(1),
  /** Level de sensibilité (C0-C3) — préservé pour l'ExecutionRecord. */
  sensitivityLevel: sensitivityLevelSchema,
  /** Identifiant du grant lié (optionnel). */
  grantId: z.string().optional(),
  /** Horodatage de création (RESERVED). */
  createdAt: isoDateTimeSchema,
  /** Horodatage de dernière transition. */
  updatedAt: isoDateTimeSchema,
  /** Horodatage de complétion (optionnel). */
  completedAt: isoDateTimeSchema.optional(),
  /** Résultat du rejeu (présent quand state = COMPLETED). */
  replayResult: z.unknown().optional(),
});

export type IdempotencyEntry = z.infer<typeof idempotencyEntrySchema>;

// ─────────────────────────────────────
// ExecutionRecord
// ─────────────────────────────────────

export const executionRecordEventTypeSchema = z.enum([
  "tool.invocation_reserved",
  "tool.invocation_started",
  "tool.invocation_completed",
  "tool.invocation_failed",
  "tool.invocation_unknown",
]);

export type ExecutionRecordEventType = z.infer<typeof executionRecordEventTypeSchema>;

export const executionRecordEventSchema = z.object({
  type: executionRecordEventTypeSchema,
  occurredAt: isoDateTimeSchema,
  /** Données de l'événement — jamais de credentials bruts. */
  data: z.record(z.string(), z.unknown()).default({}),
});
export type ExecutionRecordEvent = z.infer<typeof executionRecordEventSchema>;

/**
 * ExecutionRecord — append-only, immuable.
 *
 * Contient l'historique complet du cycle de vie d'une invocation.
 * Ne JAMAIS muter un événement ancien.
 */
export const executionRecordSchema = z.object({
  id: idSchema,
  tenantId: z.string().min(1),
  missionId: z.string().min(1),
  runId: z.string().min(1),
  idempotencyKey: idempotencyKeySchema,
  requestHash: requestHashSchema,
  /** Grant lié (optionnel — présent si un grant a été émis). */
  grantId: z.string().optional(),
  /** Principal ayant initié l'invocation. */
  principalId: z.string().min(1),
  /** Level de sensibilité (C0-C3). */
  sensitivityLevel: sensitivityLevelSchema,
  /** Événements du cycle de vie (append-only). */
  events: z.array(executionRecordEventSchema).min(1),
  /** Résultat final (présent pour COMPLETED/FAILED_SAFE). */
  outputHash: z.string().optional(),
  /** Références vers les artefacts (pas les contenus bruts). */
  artifactRefs: z.array(z.string()).default([]),
  /** Code d'erreur final (présent en cas d'échec). */
  errorCode: z.string().optional(),
  /** Message d'erreur (sanitizé, pas de credentials). */
  errorMessage: z.string().optional(),
  /** Durée totale en ms. */
  durationMs: z.number().int().nonnegative().default(0),
  /** Métriques d'usage AI (optionnel). */
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
      providerId: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
  /** Horodatage de création du record. */
  createdAt: isoDateTimeSchema,
  /** Dernière mise à jour. */
  updatedAt: isoDateTimeSchema,
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
