/**
 * ICOS Workspace Manager — modèle de données. Outillage de développement multi-workers :
 * pas de données tenant, pas de dépendance Next.js/Drizzle.
 */

export const WORKSPACE_STATUSES = [
  "requested",
  "creating",
  "ready",
  "working",
  "validating",
  "ready_for_integration",
  "integrating",
  "accepted",
  "rejected",
  "blocked",
  "abandoned",
] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** Transitions autorisées ; tout le reste est refusé (fail-closed). */
export const WORKSPACE_TRANSITIONS: Record<WorkspaceStatus, readonly WorkspaceStatus[]> = {
  requested: ["creating", "abandoned"],
  creating: ["ready", "blocked", "abandoned"],
  ready: ["working", "abandoned"],
  working: ["validating", "blocked", "abandoned"],
  validating: ["working", "ready_for_integration", "blocked", "abandoned"],
  ready_for_integration: ["integrating", "working", "abandoned"],
  integrating: ["accepted", "rejected", "working", "blocked"],
  accepted: [],
  rejected: ["working", "abandoned"],
  blocked: ["working", "abandoned"],
  abandoned: [],
};

/** États terminaux : le workspace n'évolue plus, ses ressources attendent le cleanup. */
export const CLEANABLE_STATUSES: readonly WorkspaceStatus[] = ["accepted", "rejected", "abandoned"];

export interface FileScope {
  owns: string[];
  shared: string[];
  forbidden: string[];
}

export interface MigrationReservation {
  /** Premier numéro réservé (préfixe `NNNN_` du fichier drizzle). */
  from: number;
  /** Dernier numéro réservé (inclus). */
  to: number;
  /** Namespace logique à utiliser dans le nom des fichiers : `NNNN_<namespace>_<nom>.sql`. */
  namespace: string;
}

export interface Workspace {
  workspaceId: string;
  /** Identifiant court [a-z0-9_-] ; dérive branche, chemin et base de test. */
  slug: string;
  workerId: string;
  missionId: string | null;
  taskId: string | null;
  status: WorkspaceStatus;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  integrationTarget: string;
  testDatabase: string;
  fileScope: FileScope;
  migrationReservation: MigrationReservation | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  /** Fencing token - monotonic counter for lease ownership verification */
  fencingToken: number;
  /** Workflow ID for canonical execution identity and idempotency */
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Renseigné par le cleanup : worktree, DB, lease et réservations libérés. */
  releasedAt: string | null;
  /** Dernier commit soumis à l'Integration Gate. */
  sourceCommit: string | null;
  /**
   * LE DÉPÔT CANONIQUE AUQUEL CE WORKSPACE APPARTIENT, lié à l'allocation.
   *
   * Décidé par l'allocateur de confiance avant qu'aucun worker n'existe, et porté par
   * l'enregistrement : la matérialisation s'en sert au lieu de consulter un état de processus
   * (`ICOS_REPO_PATH`, un conteneur singleton) qui peut avoir changé entre la fin de
   * l'exécution et la capture. `null` = enregistrement antérieur à cette liaison, qui est
   * REFUSÉ à la capture plutôt que deviné.
   */
  canonicalRepo: string | null;
}

export type IntegrationDecision = "ACCEPT" | "REJECT" | "NEEDS_REBASE" | "NEEDS_HUMAN_APPROVAL";

export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WorkspaceError";
  }
}
