import type {
  TaskDag,
  TaskNode,
  TaskNodeStatus,
  DagStatus,
  CreateDagInput,
} from "@/core/supervisor";

// ─────────────────────────────────────
// SupervisorRepository
// ─────────────────────────────────────

export interface SupervisorRepository {
  /** Crée un nouveau DAG. */
  createDag(input: CreateDagInput): Promise<TaskDag>;

  /** Récupère un DAG par son ID. */
  findDagById(id: string): Promise<TaskDag | null>;

  /** Récupère tous les DAGs pour une mission. */
  findDagsByMissionId(missionId: string): Promise<TaskDag[]>;

  /** Récupère les DAGs actifs (non terminaux). */
  findActiveDags(): Promise<TaskDag[]>;

  /** Met à jour l'état d'un DAG. */
  updateDagStatus(
    dagId: string,
    status: DagStatus,
    error?: string,
  ): Promise<TaskDag | null>;

  /** Ajoute un nœud à un DAG. */
  addNode(dagId: string, node: TaskNode): Promise<TaskNode | null>;

  /** Met à jour l'état d'un nœud. */
  updateNodeStatus(
    dagId: string,
    nodeId: string,
    status: TaskNodeStatus,
    updates?: Partial<TaskNode>,
  ): Promise<TaskNode | null>;

  /** Récupère un nœud par son ID dans un DAG. */
  findNodeById(dagId: string, nodeId: string): Promise<TaskNode | null>;
}

// ─────────────────────────────────────
// SupervisorUnitOfWork
// ─────────────────────────────────────

/**
 * Unité de travail pour les mutations atomiques du Supervisor.
 * Wrapper autour du UoW générique avec des opérations spécifiques Supervisor.
 */
export interface SupervisorUnitOfWork {
  /** Démarre la transaction. */
  begin(): Promise<void>;

  /** Valide la transaction. */
  commit(): Promise<void>;

  /** Annule la transaction. */
  rollback(): Promise<void>;

  /** Met à jour l'état d'un nœud atomiquement (avec vérification de l'état source). */
  transitionNodeStatus(
    dagId: string,
    nodeId: string,
    fromStatus: TaskNodeStatus,
    toStatus: TaskNodeStatus,
    updates?: Partial<TaskNode>,
  ): Promise<TaskNode | null>;
}

// ─────────────────────────────────────
// SchedulerPort
// ─────────────────────────────────────

/**
 * Port du Scheduler — point d'entrée pour déclencher la logique
 * de planification depuis l'infrastructure (après restauration, etc.).
 */
export interface SchedulerPort {
  /** Démarre le scheduling du DAG. */
  startDag(dagId: string): Promise<void>;

  /** Notifie la complétion d'un nœud. */
  notifyNodeCompleted(dagId: string, nodeId: string): Promise<void>;

  /** Notifie l'échec d'un nœud. */
  notifyNodeFailed(dagId: string, nodeId: string, error?: string): Promise<void>;
}

// ─────────────────────────────────────
// SupervisorPort
// ─────────────────────────────────────

/**
 * Port principal du Supervisor.
 * Point d'entrée pour D2 ou l'interface humaine.
 */
export interface SupervisorPort {
  /**
   * Lance l'exécution d'une mission via le Supervisor.
   * Crée le DAG, démarre le scheduler, et orchestre l'ensemble.
   */
  executeDag(dag: TaskDag): Promise<void>;

  /** Récupère l'état actuel d'une exécution. */
  getDagState(dagId: string): Promise<TaskDag | null>;

  /** Annule l'exécution d'un DAG. */
  cancelDag(dagId: string): Promise<void>;

  /** Relance un nœud échoué. */
  retryNode(dagId: string, nodeId: string): Promise<void>;
}
