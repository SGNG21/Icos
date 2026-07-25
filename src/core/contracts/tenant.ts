import { z } from "zod";

/**
 * Identifiant de tenant validé.
 *
 * Ne jamais accepter une valeur non validée provenant du client
 * (body, query, path, header non signé). Le TenantId est toujours
 * résolu depuis le contexte authentifié.
 */
export const tenantIdSchema = z.string().min(1).max(128);

export type TenantId = z.infer<typeof tenantIdSchema>;

/**
 * Contexte de tenant authentifié et validé.
 *
 * Invariant critique :
 *   CLIENT-SUPPLIED TENANT ID ≠ AUTHENTICATED TENANT CONTEXT
 *
 * TenantContext est toujours résolu depuis le contexte authentifié
 * (session utilisateur), jamais depuis des données non fiables
 * de la requête entrante.
 */
export const tenantContextSchema = z.object({
  tenantId: tenantIdSchema,
  resolvedAt: z.string().datetime(),
  /** Origine de la résolution : "auth", "system", "migration", "test" */
  resolvedBy: z.string(),
});

export type TenantContext = z.infer<typeof tenantContextSchema>;

/**
 * Résultat de résolution de tenant.
 *
 * Règle FAIL_CLOSED : si aucun tenant valide n'est résolu,
 * le résultat est un échec — pas de fallback silencieux.
 */
export type TenantResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; reason: "no_tenant" | "invalid_tenant" | "resolution_error" };

// ─────────────────────────────────────
// Data classification schemas (COMPLIANCE-0/1)
// ─────────────────────────────────────

/**
 * Catégorie fonctionnelle des données.
 */
export const dataCategorySchema = z.enum([
  "PUBLIC",
  "INTERNAL",
  "PERSONAL",
  "SENSITIVE_PERSONAL",
  "CONFIDENTIAL_CLIENT",
  "AUTH_SECRET",
  "FINANCIAL",
  "LEGAL",
  "HEALTH",
  "HR",
  "CHILD_DATA",
  "BIOMETRIC",
  "DERIVED_PROFILE",
]);

export type DataCategory = z.infer<typeof dataCategorySchema>;

/**
 * Niveau de sensibilité (C0–C3).
 * Distinct de DataCategory : une donnée PERSONAL peut être
 * C2 ou C3 selon le contexte.
 */
export const sensitivityLevelSchema = z.enum(["C0", "C1", "C2", "C3"]);

export type SensitivityLevel = z.infer<typeof sensitivityLevelSchema>;

/**
 * Contrat de politique de rétention pour une Capability C3.
 *
 * L'implémentation complète (purge, expiration) est COMPLIANCE-2.
 * COMPLIANCE-1 pose le contrat déclaratif et la validation
 * qui refuse l'activation d'une Capability C3 sans politique
 * de rétention associée.
 */
export const retentionPolicyRefSchema = z.object({
  /** Durée de conservation maximale en jours */
  maxRetentionDays: z.number().int().positive(),
  /** Base légale RGPD */
  legalBasis: z.enum([
    "consent",
    "contract",
    "legal_obligation",
    "legitimate_interest",
  ]),
  /** Description de la finalité du traitement */
  purpose: z.string().min(1),
});

export type RetentionPolicyRef = z.infer<typeof retentionPolicyRefSchema>;
