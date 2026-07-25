import type { SensitivityLevel } from "@/core/contracts/tenant";

/**
 * Codes de refus normalisés D1.
 * Chaque refus a un code unique pour audit et debugging.
 */
export type PolicyDenialCode =
  | "unauthenticated"
  | "no_tenant"
  | "forbidden"
  | "classification_too_high"
  | "retention_policy_required"
  | "insufficient_authorization"
  | "capability_not_found"
  | "capability_inactive"
  | "cross_tenant_idor"
  | "external_mutation_requires_approval"
  | "policy_denied";

/**
 * Décision de politique D1.
 *
 * INVARIANT : une erreur interne, un état inconnu ou une incohérence produit
 * toujours DENY (fail-closed), jamais de fallback silencieux vers ALLOW.
 */
export type PolicyDecision =
  | { outcome: "allow"; reason: string; attestedAt: string }
  | { outcome: "deny"; reason: string; code: PolicyDenialCode }
  | { outcome: "require_approval"; reason: string; expiresAt: string };

/** Acteur de la requête (humain ou agent). */
export interface PolicyActor {
  kind: "human" | "agent";
  id: string;
  tenantId: string;
  roles?: readonly string[];
  authorizationLevel?: number;
}

/** Resource cible de l'action. */
export interface PolicyResource {
  type: string;
  id: string;
  /** Classification de la resource, si connue. */
  sensitivityLevel?: SensitivityLevel;
  dataCategory?: string;
  /** Tenant propriétaire de la resource. */
  ownerTenantId?: string;
  /** Politique de retention attachée (C3). */
  retentionPolicyRef?: unknown;
}

/** Environnement d'exécution. */
export interface PolicyEnvironment {
  backendType: "memory" | "postgres";
  executionMode: "normal" | "system" | "migration" | "test";
}

/**
 * Requête complète de décision D1.
 *
 * Tous les champs ne sont pas toujours requis : le PolicyEngine applique
 * les gates disponibles et ignore les informations absentes.
 */
export interface PolicyRequest {
  actor: PolicyActor;
  tenant: { tenantId: string };
  action: string;
  resource: PolicyResource;
  /** Clé de capacité associée (optionnelle). */
  capabilityKey?: string;
  /** Niveau de risque déclaré. */
  risk?: "read_only" | "reversible" | "sensitive";
  /** L'action a-t-elle un effet externe (mutation outside ICOS) ? */
  hasExternalEffect?: boolean;
  /** Environnement. */
  environment?: PolicyEnvironment;
}
