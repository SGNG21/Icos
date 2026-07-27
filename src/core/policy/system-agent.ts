/**
 * SystemAgent — identité système ICOS porteuse de permissions explicites.
 *
 * Un SystemAgent est créé exclusivement au bootstrap (composition root) et
 * jamais auto-attribué par un composant applicatif (Supervisor, Worker, etc.).
 *
 * INVARIANT : la création d'un SystemAgent est un acte de confiance documenté,
 * pas une auto-déclaration. Chaque SystemAgent a une `justification` lisible
 * qui explique pourquoi cette autorisation existe.
 *
 * Liens :
 *   - Utilisé par SupervisorConfig → CreateWorkerInput → WorkerManager → D1
 *   - Les permissions transitent via PolicyRequest.actor
 *   - D1/PermissionGate vérifie `actor.roles` contre `resource.type.action`
 */

import type { SensitivityLevel } from "@/core/contracts/tenant";

// ─────────────────────────────────────
// Actions système canoniques
// ─────────────────────────────────────

/**
 * Actions système prédéfinies pour le Supervisor.
 * Toute nouvelle action doit être ajoutée ici avec documentation.
 */
export const SYSTEM_ACTIONS = {
  /** Déléguer l'exécution d'un worker au sein d'un DAG. */
  SUPERVISOR_WORKER_EXECUTE: "supervisor.worker.execute",
} as const;

export type SystemActionKey = keyof typeof SYSTEM_ACTIONS;

/** Type de ressource pour l'exécution d'un worker. */
export const RESOURCE_TYPE_WORKER_EXECUTION = "worker-execution" as const;

/**
 * Construit la permission canonique pour une action système.
 * Format : `resourceType.actionName` (ex: "worker-execution.supervisor.worker.execute").
 * Correspond à ce que PermissionGate attend via `${resource.type}.${action}`.
 */
export function systemPermission(action: string, resourceType: string): string {
  return `${resourceType}.${action}`;
}

/**
 * Permission spécifique à l'exécution d'un worker par le Supervisor.
 * C'est la seule permission système minimale requise pour FIRST-AUTO-1.
 */
export const PERMISSION_SUPERVISOR_WORKER_EXECUTE = systemPermission(
  SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE,
  RESOURCE_TYPE_WORKER_EXECUTION,
);

// ─────────────────────────────────────
// SystemAgent
// ─────────────────────────────────────

/**
 * Agent système avec permissions explicitement attribuées.
 *
 * @example
 * ```ts
 * const supervisorAgent: SystemAgent = {
 *   id: "supervisor",
 *   tenantId: "icos-single-tenant",
 *   roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
 *   authorizationLevel: 2,
 *   justification: "Supervisor needs worker execution to run DAG tasks",
 * };
 * ```
 */
export interface SystemAgent {
  /** Identifiant unique du system agent (ex: "supervisor", "deployer"). */
  id: string;
  /**
   * Tenant auquel cet agent est lié.
   * Les actions seront limitées à ce tenant par le TenantGate et IDORGate.
   */
  tenantId: string;
  /**
   * Permissions explicitement attribuées.
   * Utiliser les constantes PERMISSION_* pour les valeurs.
   * Sera propagé dans PolicyRequest.actor.roles.
   */
  roles: readonly string[];
  /**
   * Niveau d'autorisation pour le RiskGate.
   * 0 = read_only, 2 = reversible, 3+ = sensitive.
   * Pour l'exécution worker, 2 est suffisant (reversible).
   */
  authorizationLevel: number;
  /**
   * Justification documentée obligatoire.
   * Explique POURQUOI ce SystemAgent a besoin de ces permissions.
   * Permet la revue de sécurité et l'audit.
   */
  justification: string;
}
