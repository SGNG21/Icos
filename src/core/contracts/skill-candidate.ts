import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";

/**
 * États de vérification du candidat (pre-registry).
 * Ne confèrent aucune autorisation d'exécution.
 */
export const candidateVerificationStateSchema = z.enum([
  "pending",
  "incomplete",
  "verified",
  "failed",
]);

export type CandidateVerificationState = z.infer<
  typeof candidateVerificationStateSchema
>;

/**
 * États de trust du candidat (pre-registry).
 * Distincts du trustState du Skill canonique.
 */
export const candidateTrustStateSchema = z.enum([
  "untrusted",
  "quarantined",
  "reviewed",
  "approved",
  "rejected",
]);

export type CandidateTrustState = z.infer<typeof candidateTrustStateSchema>;

/**
 * États de sécurité du candidat (pre-registry).
 */
export const candidateSecurityStateSchema = z.enum([
  "pending",
  "scanning",
  "passed",
  "failed",
  "error",
]);

export type CandidateSecurityState = z.infer<
  typeof candidateSecurityStateSchema
>;

/**
 * États de compatibilité du candidat (pre-registry).
 */
export const candidateCompatibilityStateSchema = z.enum([
  "unknown",
  "compatible",
  "compatible_with_adapter",
  "compatible_with_limits",
  "incompatible",
]);

export type CandidateCompatibilityState = z.infer<
  typeof candidateCompatibilityStateSchema
>;

/**
 * Preuve d'une capacité revendiquée par la source externe.
 * Le titre/nom seul NE suffit pas — il faut une preuve explicite
 * (ex. manifest, code, doc, test, example).
 */
export const capabilityClaimEvidenceSchema = z.object({
  capabilityKey: z
    .string()
    .min(3)
    .regex(
      /^[a-z0-9][a-z0-9_-]+(\.[a-z0-9][a-z0-9_-]+)*$/,
      "clé capacité invalide",
    ),
  /** Type de preuve : manifest, code, documentation, test, example, other */
  evidenceType: z.enum([
    "manifest",
    "code",
    "documentation",
    "test",
    "example",
    "other",
  ]),
  /** Description lisible de la preuve */
  description: z.string().min(1),
  /** Confiance 0..1 — 0.5 par défaut si absent */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Référence vers la source de la preuve (URL, path, hash) */
  sourceRef: z.string().optional(),
});

export type CapabilityClaimEvidence = z.infer<
  typeof capabilityClaimEvidenceSchema
>;

/**
 * Indice de compatibilité fourni par la source.
 * Ne constitue PAS une décision de compatibilité ICOS.
 */
export const compatibilityHintSchema = z.object({
  /** Ex: "nextjs>=15", "react>=18", "node>=20", "mcp", "langgraph" */
  target: z.string().min(1),
  /** Type d'indice : runtime, framework, protocol, platform, tooling, other */
  hintType: z.enum([
    "runtime",
    "framework",
    "protocol",
    "platform",
    "tooling",
    "other",
  ]),
  /** Description */
  description: z.string().min(1),
  /** Version ou contrainte si applicable */
  version: z.string().optional(),
});

export type CompatibilityHint = z.infer<typeof compatibilityHintSchema>;

/**
 * Provenance du candidat découverte.
 */
export const candidateProvenanceSchema = z.object({
  /** Identifiant du provider de découverte (ex: "skillsmp") */
  providerId: z.string().min(1),
  /** Identifiant externe dans le système source */
  externalId: z.string().min(1),
  /** URL de la page de découverte si disponible */
  discoveryUrl: z.string().url().optional(),
  /** URL du dépôt source si connue */
  sourceRepository: z.string().optional(),
  /** Commit, tag ou version du source si connu */
  sourceCommitOrVersion: z.string().optional(),
  /** Mainteneur si connu */
  maintainer: z.string().optional(),
  /** Horodatage de la découverte (ICOS) */
  discoveredAt: isoDateTimeSchema,
  /** Horodatage de mise à jour de la source (si connue) */
  sourceUpdatedAt: isoDateTimeSchema.optional(),
});

export type CandidateProvenance = z.infer<typeof candidateProvenanceSchema>;

/**
 * Candidat de skill découvert (pre-registry, non-exécutable).
 *
 * NE CONTIENT PAS :
 * - scripts, resources, contenu téléchargé
 * - credentials, permissions, outils
 * - trustState/activationState du Skill canonique
 * - Aucune autorité runtime
 */
export const skillCandidateSchema = z.object({
  /** Identifiant canonique ICOS du candidat */
  candidateId: idSchema,
  /** Identifiant du provider (ex: "skillsmp") */
  providerId: z.string().min(1),
  /** Identifiant externe dans le système source */
  externalId: z.string().min(1),
  /** Nom tel que fourni par la source */
  name: z.string().min(1),
  /** Description fournie par la source */
  description: z.string().optional(),
  /** URL de la page du skill sur le provider */
  sourceUrl: z.string().url().optional(),
  /** URL du dépôt source (GitHub, GitLab, etc.) */
  sourceRepository: z.string().optional(),
  /** Commit, tag ou version du source */
  sourceCommitOrVersion: z.string().optional(),
  /** Mainteneur si connu */
  maintainer: z.string().optional(),
  /** Tags fournis par la source */
  tags: z.array(z.string()).default([]),
  /** Revendications de capacité AVEC preuves explicites */
  capabilityClaims: z.array(capabilityClaimEvidenceSchema).default([]),
  /** Indices de compatibilité fournis par la source */
  compatibilityHints: z.array(compatibilityHintSchema).default([]),
  /** Provenance de la découverte */
  provenance: candidateProvenanceSchema,
  /** Hash déterministe des métadonnées normalisées du candidat */
  rawMetadataHash: z.string().min(1),
  /** État de vérification (découverte → vérification) */
  verificationState: candidateVerificationStateSchema,
  /** État de trust (pre-registry) — fail-closed par défaut */
  trustState: candidateTrustStateSchema,
  /** État de sécurité (pre-registry) — fail-closed par défaut */
  securityState: candidateSecurityStateSchema,
  /** État de compatibilité (pre-registry) — fail-closed par défaut */
  compatibilityState: candidateCompatibilityStateSchema,
});

export type SkillCandidate = z.infer<typeof skillCandidateSchema>;

/**
 * Résultat paginé de recherche de candidats.
 */
export const candidateSearchResultSchema = z.object({
  candidates: z.array(skillCandidateSchema),
  pagination: z.object({
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0).optional(),
    totalPages: z.number().int().min(0).optional(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
    totalIsExact: z.boolean().optional(),
    isCapped: z.boolean().optional(),
  }),
});

export type CandidateSearchResult = z.infer<
  typeof candidateSearchResultSchema
>;

/**
 * Codes d'erreur typés pour le provider SkillsMP.
 */
export const skillsMpErrorCodeSchema = z.enum([
  "SKILLSMP_CREDENTIAL_UNAVAILABLE",
  "SKILLSMP_RATE_LIMITED",
  "SKILLSMP_UNAVAILABLE",
  "SKILLSMP_AUTH_FAILED",
  "SKILLSMP_INVALID_RESPONSE",
  "SKILLSMP_TIMEOUT",
  "SKILLSMP_CANDIDATE_INCOMPLETE",
  "SKILLSMP_SOURCE_UNAVAILABLE",
]);

export type SkillsMpErrorCode = z.infer<typeof skillsMpErrorCodeSchema>;

export class SkillsMpError extends Error {
  readonly code: SkillsMpErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: SkillsMpErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "SkillsMpError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
  }
}

/**
 * Vérifie si un code d'erreur est retryable.
 */
export function isSkillsMpErrorRetryable(code: SkillsMpErrorCode): boolean {
  return code === "SKILLSMP_RATE_LIMITED" || code === "SKILLSMP_UNAVAILABLE" || code === "SKILLSMP_TIMEOUT";
}