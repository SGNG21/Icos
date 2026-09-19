import { z } from "zod";

import { isoDateTimeSchema, jsonValueSchema } from "@/core/contracts/common";

/**
 * Contrats de la mémoire opérationnelle (Phase 7B). Trois mémoires séparées :
 * mission (preuve append-only), procédurale (savoir-faire agrégé), utilisateur/
 * business (déclarations humaines). Voir docs/icos/phase-7b-memory/DESIGN.md.
 *
 * Ne JAMAIS y placer de secret : `assertNoSecrets` est appliqué avant écriture.
 */

// ── Enveloppe commune ────────────────────────────────────────────────────────
export const MEMORY_SOURCE_TYPES = [
  "execution_result",
  "review_decision",
  "audit_entry",
  "mission",
  "mission_plan",
  "checkpoint",
  "human_input",
  "agent_report",
  "system",
] as const;
export const memorySourceTypeSchema = z.enum(MEMORY_SOURCE_TYPES);
export type MemorySourceType = z.infer<typeof memorySourceTypeSchema>;

export const memoryActorKindSchema = z.enum(["human", "agent", "system"]);
export type MemoryActorKind = z.infer<typeof memoryActorKindSchema>;

/** Qui agit / lit. `tenantId` est obligatoire : pas de tenant, pas d'opération. */
export interface MemoryActor {
  readonly tenantId: string;
  readonly kind: MemoryActorKind;
  readonly id: string;
  readonly permissions: readonly string[];
  /** Utilisateur pour le compte duquel un worker lit la mémoire privée. */
  readonly onBehalfOfUserId?: string;
}
export type HumanActor = MemoryActor & { readonly kind: "human" };

export const provenanceSchema = z
  .object({ sourceType: memorySourceTypeSchema, sourceId: z.string().min(1).max(255) })
  .strict();

export const confidenceBasisSchema = z.enum(["observed", "derived", "declared", "validated"]);
export const confidenceSchema = z
  .object({ value: z.number().min(0).max(1), basis: confidenceBasisSchema })
  .strict();

export const visibilityKindSchema = z.enum(["tenant", "restricted", "private"]);
export const visibilitySchema = z
  .object({
    visibility: visibilityKindSchema.default("tenant"),
    ownerSubject: z.string().min(1).max(255).nullable().default(null),
    requiredPermission: z.string().min(1).max(100).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.visibility === "private" && !v.ownerSubject) {
      ctx.addIssue({ code: "custom", message: "private visibility requires ownerSubject" });
    }
    if (v.visibility === "restricted" && !v.requiredPermission) {
      ctx.addIssue({
        code: "custom",
        message: "restricted visibility requires requiredPermission",
      });
    }
  });

/** Fenêtres de fraîcheur optionnelles fournies par l'appelant (sinon défauts). */
export const freshnessOverrideSchema = z
  .object({
    lastVerifiedAt: isoDateTimeSchema.optional(),
    staleAfter: isoDateTimeSchema.nullable().optional(),
    expiresAt: isoDateTimeSchema.nullable().optional(),
  })
  .strict();

const title = z.string().min(1).max(200);
const summary = z.string().min(1).max(2_000);
const payload = z.record(z.string(), jsonValueSchema);
const idText = z.string().min(1).max(255);

export const freshnessStateSchema = z.enum(["fresh", "stale", "expired"]);
export type FreshnessState = z.infer<typeof freshnessStateSchema>;

/** Colonnes communes d'une entrée persistée (forme plate = forme SQL). */
const envelopeShape = {
  id: idText,
  tenantId: idText,
  sourceType: memorySourceTypeSchema,
  sourceId: idText,
  recordedByType: memoryActorKindSchema,
  recordedBy: idText,
  occurredAt: isoDateTimeSchema,
  recordedAt: isoDateTimeSchema,
  lastVerifiedAt: isoDateTimeSchema,
  staleAfter: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  confidence: z.number().min(0).max(1),
  confidenceBasis: confidenceBasisSchema,
  visibility: visibilityKindSchema,
  ownerSubject: z.string().nullable(),
  requiredPermission: z.string().nullable(),
} as const;

// ── Mission memory ───────────────────────────────────────────────────────────
export const MISSION_MEMORY_KINDS = [
  "objective",
  "plan",
  "decision",
  "result",
  "error",
  "retry",
  "review",
  "artifact",
  "terminal_state",
] as const;
export const missionMemoryKindSchema = z.enum(MISSION_MEMORY_KINDS);
export type MissionMemoryKind = z.infer<typeof missionMemoryKindSchema>;

export const missionMemoryInputSchema = z
  .object({
    missionId: idText,
    missionTaskId: idText.optional(),
    kind: missionMemoryKindSchema,
    title,
    summary,
    payload: payload.default({}),
    provenance: provenanceSchema,
    occurredAt: isoDateTimeSchema,
    confidence: confidenceSchema,
    freshness: freshnessOverrideSchema.optional(),
    visibility: visibilitySchema.default({
      visibility: "tenant",
      ownerSubject: null,
      requiredPermission: null,
    }),
    supersedesId: idText.optional(),
  })
  .strict()
  .transform((v) => ({ ...v, scope: v.missionTaskId ? ("task" as const) : ("mission" as const) }));
export type MissionMemoryInput = z.output<typeof missionMemoryInputSchema>;
export type MissionMemoryInputRaw = z.input<typeof missionMemoryInputSchema>;

export const missionMemoryEntrySchema = z.object({
  ...envelopeShape,
  missionId: idText,
  missionTaskId: idText.nullable(),
  scope: z.enum(["mission", "task"]),
  kind: missionMemoryKindSchema,
  title,
  summary,
  payload,
  supersedesId: idText.nullable(),
});
export type MissionMemoryEntry = z.infer<typeof missionMemoryEntrySchema>;

// ── Procedural memory ────────────────────────────────────────────────────────
export const PROCEDURAL_KINDS = [
  "successful_plan",
  "strategy",
  "skill_usage",
  "recovery_pattern",
  "recurring_error",
  "validated_remediation",
] as const;
export const proceduralKindSchema = z.enum(PROCEDURAL_KINDS);
export type ProceduralKind = z.infer<typeof proceduralKindSchema>;
export const proceduralScopeSchema = z.enum(["tenant", "capability", "worker_kind"]);
export const proceduralStatusSchema = z.enum(["candidate", "validated", "deprecated"]);
export type ProceduralStatus = z.infer<typeof proceduralStatusSchema>;

/** Sentinelle de `scope_key` pour la portée `tenant` (évite les NULL dans l'unicité). */
export const TENANT_SCOPE_KEY = "*";

export const proceduralObservationSchema = z
  .object({
    kind: proceduralKindSchema,
    scope: proceduralScopeSchema.default("tenant"),
    scopeKey: idText.optional(),
    /** Clé déterministe de dédoublonnage, ex. `website.build|hermes|WORKER_TIMEOUT`. */
    signature: z.string().min(1).max(300),
    title,
    summary,
    payload: payload.default({}),
    outcome: z.enum(["success", "failure"]),
    /** La source de CETTE observation (une observation = un couple source unique). */
    provenance: provenanceSchema,
    missionId: idText.optional(),
    occurredAt: isoDateTimeSchema,
    visibility: visibilitySchema.default({
      visibility: "tenant",
      ownerSubject: null,
      requiredPermission: null,
    }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "tenant" && v.scopeKey !== undefined) {
      ctx.addIssue({ code: "custom", message: "tenant scope takes no scopeKey" });
    }
    if (v.scope !== "tenant" && !v.scopeKey) {
      ctx.addIssue({ code: "custom", message: `${v.scope} scope requires scopeKey` });
    }
    if (v.kind === "validated_remediation") {
      ctx.addIssue({
        code: "custom",
        message:
          "validated_remediation is recorded by a human (recordValidatedRemediation), never observed",
      });
    }
  });
export type ProceduralObservation = z.output<typeof proceduralObservationSchema>;
export type ProceduralObservationRaw = z.input<typeof proceduralObservationSchema>;

export const proceduralEntrySchema = z.object({
  ...envelopeShape,
  kind: proceduralKindSchema,
  scope: proceduralScopeSchema,
  scopeKey: idText,
  signature: z.string(),
  title,
  summary,
  payload,
  status: proceduralStatusSchema,
  occurrenceCount: z.number().int().min(1),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  firstObservedAt: isoDateTimeSchema,
  lastObservedAt: isoDateTimeSchema,
  validatedBy: z.string().nullable(),
  validatedAt: isoDateTimeSchema.nullable(),
  validatedSourceType: memorySourceTypeSchema.nullable(),
  validatedSourceId: z.string().nullable(),
});
export type ProceduralEntry = z.infer<typeof proceduralEntrySchema>;

/** Preuve d'une validation humaine (jamais une exécution brute). */
export const validationEvidenceSchema = z
  .object({ sourceType: z.enum(["human_input", "review_decision"]), sourceId: idText })
  .strict();
export type ValidationEvidence = z.infer<typeof validationEvidenceSchema>;

/** Remédiation validée : créée par un humain, toujours avec preuve. */
export const remediationInputSchema = z
  .object({
    scope: proceduralScopeSchema.default("tenant"),
    scopeKey: idText.optional(),
    signature: z.string().min(1).max(300),
    title,
    summary,
    payload: payload.default({}),
    evidence: validationEvidenceSchema,
    missionId: idText.optional(),
    occurredAt: isoDateTimeSchema,
    visibility: visibilitySchema.default({
      visibility: "tenant",
      ownerSubject: null,
      requiredPermission: null,
    }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "tenant" && v.scopeKey !== undefined) {
      ctx.addIssue({ code: "custom", message: "tenant scope takes no scopeKey" });
    }
    if (v.scope !== "tenant" && !v.scopeKey) {
      ctx.addIssue({ code: "custom", message: `${v.scope} scope requires scopeKey` });
    }
  });
export type RemediationInput = z.output<typeof remediationInputSchema>;
export type RemediationInputRaw = z.input<typeof remediationInputSchema>;

export interface ProceduralEvidence {
  readonly id: string;
  readonly entryId: string;
  readonly sourceType: MemorySourceType;
  readonly sourceId: string;
  readonly missionId: string | null;
  readonly outcome: "success" | "failure";
  readonly observedAt: string;
  readonly recordedAt: string;
}

// ── Business / user memory ───────────────────────────────────────────────────
export const BUSINESS_KINDS = ["preference", "business_fact", "constraint", "guideline"] as const;
export const businessKindSchema = z.enum(BUSINESS_KINDS);
export const businessScopeSchema = z.enum(["user", "tenant"]);
export const businessStatusSchema = z.enum([
  "proposed",
  "active",
  "superseded",
  "retracted",
  "rejected",
]);
export type BusinessStatus = z.infer<typeof businessStatusSchema>;

export const businessMemoryInputSchema = z
  .object({
    kind: businessKindSchema,
    scope: businessScopeSchema,
    /** Identifiant utilisateur pour la portée `user` ; interdit pour `tenant`. */
    scopeKey: idText.optional(),
    /** Clé pointée stable, ex. `brand.tone`. */
    subjectKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "subjectKey invalide"),
    summary,
    value: payload,
    provenance: provenanceSchema,
    occurredAt: isoDateTimeSchema,
    confidence: confidenceSchema,
    freshness: freshnessOverrideSchema.optional(),
    visibility: visibilitySchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "user" && !v.scopeKey) {
      ctx.addIssue({ code: "custom", message: "user scope requires scopeKey (user id)" });
    }
    if (v.scope === "tenant" && v.scopeKey !== undefined) {
      ctx.addIssue({ code: "custom", message: "tenant scope takes no scopeKey" });
    }
  });
export type BusinessMemoryInput = z.output<typeof businessMemoryInputSchema>;
export type BusinessMemoryInputRaw = z.input<typeof businessMemoryInputSchema>;

export const businessMemoryEntrySchema = z.object({
  ...envelopeShape,
  kind: businessKindSchema,
  scope: businessScopeSchema,
  scopeKey: idText,
  subjectKey: z.string(),
  summary,
  value: payload,
  version: z.number().int().min(1).nullable(),
  status: businessStatusSchema,
  decidedBy: z.string().nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  supersedesId: idText.nullable(),
});
export type BusinessMemoryEntry = z.infer<typeof businessMemoryEntrySchema>;

// ── Retrieval ────────────────────────────────────────────────────────────────
export const MEMORY_TYPES = ["mission", "procedural", "business"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface RetrievalStats {
  /** Lignes correspondant aux filtres de portée, avant visibilité/fraîcheur/limite. */
  readonly matched: number;
  readonly returned: number;
  readonly denied: number;
  readonly expired: number;
  /** Superseded / deprecated / non actif / non validé selon la mémoire. */
  readonly inactive: number;
}

export interface RetrievedEntry<E> {
  readonly entry: E;
  readonly freshness: FreshnessState;
  readonly rank: number;
}

export interface RetrievalResult<E> {
  readonly retrievalId: string;
  readonly memoryType: MemoryType;
  readonly entries: readonly RetrievedEntry<E>[];
  readonly stats: RetrievalStats;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
const limit = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

export const missionQuerySchema = z
  .object({
    missionId: idText,
    missionTaskId: idText.optional(),
    kinds: z.array(missionMemoryKindSchema).min(1).optional(),
    includeSuperseded: z.boolean().default(false),
    limit,
  })
  .strict();
export type MissionQuery = z.output<typeof missionQuerySchema>;
export type MissionQueryRaw = z.input<typeof missionQuerySchema>;

export const proceduralQuerySchema = z
  .object({
    kinds: z.array(proceduralKindSchema).min(1).optional(),
    capability: idText.optional(),
    workerKind: idText.optional(),
    signature: z.string().min(1).max(300).optional(),
    statuses: z.array(proceduralStatusSchema).min(1).default(["candidate", "validated"]),
    minConfidence: z.number().min(0).max(1).default(0),
    purpose: z.string().max(200).optional(),
    limit,
  })
  .strict();
export type ProceduralQuery = z.output<typeof proceduralQuerySchema>;
export type ProceduralQueryRaw = z.input<typeof proceduralQuerySchema>;

export const businessQuerySchema = z
  .object({
    scope: businessScopeSchema.optional(),
    scopeKey: idText.optional(),
    subjectKeyPrefix: z.string().min(1).max(200).optional(),
    kinds: z.array(businessKindSchema).min(1).optional(),
    purpose: z.string().max(200).optional(),
    limit,
  })
  .strict();
export type BusinessQuery = z.output<typeof businessQuerySchema>;
export type BusinessQueryRaw = z.input<typeof businessQuerySchema>;
