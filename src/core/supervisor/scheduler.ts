import type { TaskDag, TaskNode, TaskNodeStatus } from "./contract";
import { computeReadyNodes, isNodeTerminal, canRetryNode } from "./lifecycle";

// ─────────────────────────────────────
// Scheduler events
// ─────────────────────────────────────

/**
 * Événements que le Scheduler émet durant l'exécution.
 */
export interface SchedulerEvent {
  type:
    | "dag_created"
    | "dag_started"
    | "dag_completed"
    | "dag_failed"
    | "dag_cancelled"
    | "node_ready"
    | "node_assigned"
    | "node_started"
    | "node_completed"
    | "node_failed"
    | "node_blocked"
    | "node_cancelled"
    | "node_review_passed"
    | "node_review_failed"
    | "node_correction_needed"
    | "retry_attempted"
    | "human_gate_raised";
  dagId: string;
  nodeId?: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

/**
 * Gestionnaire d'événements du Scheduler.
 */
export type SchedulerEventHandler = (event: SchedulerEvent) => void | Promise<void>;

// ─────────────────────────────────────
// Scheduler
// ─────────────────────────────────────

/**
 * Résultat d'une opération du Scheduler.
 */
export type SchedulerResult<T> =
  { ok: true; data: T } | { ok: false; code: string; message: string };

/**
 * Moteur de planification / exécution du DAG.
 *
 * Le Scheduler est responsable de :
 * - Calculer les nœuds prêts
 * - Gérer la complétion des dépendances
 * - Propager les échecs
 * - Gérer les retries
 * - Lever les gates humaines
 * - Émettre des événements
 */
export class Scheduler {
  private eventHandlers: SchedulerEventHandler[] = [];

  constructor(private readonly dag: TaskDag) {}

  // ─────────────────────────────────────
  // Event handling
  // ─────────────────────────────────────

  onEvent(handler: SchedulerEventHandler): void {
    this.eventHandlers.push(handler);
  }

  private async emit(event: SchedulerEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      await handler(event);
    }
  }

  // ─────────────────────────────────────
  // Core operations
  // ─────────────────────────────────────

  /**
   * Calcule les nœuds prêts à être assignés.
   */
  getReadyNodes(): SchedulerResult<string[]> {
    if (this.dag.status !== "SCHEDULING" && this.dag.status !== "EXECUTING") {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: `Le DAG est en état ${this.dag.status}, pas de nœuds prêts`,
      };
    }

    const ready = computeReadyNodes(this.dag);
    return { ok: true, data: ready };
  }

  /**
   * Traite la complétion d'un nœud.
   * Recalcule les ready-nodes et propage l'état.
   */
  async onNodeCompleted(nodeId: string): Promise<SchedulerResult<string[]>> {
    const node = this.dag.nodes[nodeId];
    if (!node) {
      return { ok: false, code: "NODE_NOT_FOUND", message: `Nœud "${nodeId}" introuvable` };
    }

    if (!isNodeTerminal(node.status) && node.status !== "SUCCEEDED") {
      return {
        ok: false,
        code: "NOT_COMPLETED",
        message: `Le nœud "${nodeId}" est en état ${node.status}, pas terminé`,
      };
    }

    await this.emit({
      type: "node_completed",
      dagId: this.dag.id,
      nodeId,
      timestamp: new Date().toISOString(),
    });

    // Recalculer les ready-nodes
    const ready = computeReadyNodes(this.dag);

    // Émettre un événement pour chaque nouveau nœud prêt
    for (const readyNodeId of ready) {
      await this.emit({
        type: "node_ready",
        dagId: this.dag.id,
        nodeId: readyNodeId,
        timestamp: new Date().toISOString(),
      });
    }

    return { ok: true, data: ready };
  }

  /**
   * Traite l'échec d'un nœud.
   * - Si retry possible → marque READY
   * - Sinon → marque FAILED, propage BLOCKED aux dépendants
   */
  async onNodeFailed(nodeId: string, error?: string): Promise<SchedulerResult<string[]>> {
    const node = this.dag.nodes[nodeId];
    if (!node) {
      return { ok: false, code: "NODE_NOT_FOUND", message: `Nœud "${nodeId}" introuvable` };
    }

    // Vérifier si un retry est possible
    if (canRetryNode({ ...node, retryCount: 0, maxRetries: node.maxRetries })) {
      await this.emit({
        type: "retry_attempted",
        dagId: this.dag.id,
        nodeId,
        timestamp: new Date().toISOString(),
        details: { retryCount: node.retryCount + 1, maxRetries: node.maxRetries, error },
      });
      return { ok: true, data: [nodeId] };
    }

    // Échec définitif → propager aux dépendants
    const blocked: string[] = [];
    for (const [otherId, otherNode] of Object.entries(this.dag.nodes)) {
      if (otherNode.dependsOn.includes(nodeId) && otherNode.status === "PENDING") {
        blocked.push(otherId);
      }
    }

    await this.emit({
      type: "node_failed",
      dagId: this.dag.id,
      nodeId,
      timestamp: new Date().toISOString(),
      details: { blocked, error },
    });

    // Émettre BLOCKED pour chaque dépendant
    for (const blockedId of blocked) {
      await this.emit({
        type: "node_blocked",
        dagId: this.dag.id,
        nodeId: blockedId,
        timestamp: new Date().toISOString(),
        details: { blockedBy: nodeId, reason: error },
      });
    }

    return { ok: true, data: blocked };
  }

  /**
   * Vérifie si le DAG est complété (tous les nœuds terminaux).
   */
  isDagComplete(): boolean {
    const nodes = Object.values(this.dag.nodes);
    if (nodes.length === 0) return false;

    return nodes.every((node) => {
      if (node.status === "SUCCEEDED" || node.status === "CANCELLED") return true;
      if (node.status === "FAILED" || node.status === "BLOCKED") return true;
      return false;
    });
  }

  /**
   * Vérifie si un nœud peut être assigné à un worker.
   */
  canAssign(nodeId: string): SchedulerResult<true> {
    const node = this.dag.nodes[nodeId];
    if (!node) {
      return { ok: false, code: "NODE_NOT_FOUND", message: `Nœud "${nodeId}" introuvable` };
    }
    if (node.status !== "READY") {
      return {
        ok: false,
        code: "NOT_READY",
        message: `Le nœud "${nodeId}" est en état ${node.status}, pas READY`,
      };
    }
    return { ok: true, data: true as const };
  }

  /**
   * Vérifie si un nœud peut passer en WAITING_FOR_HUMAN.
   */
  canRaiseHumanGate(nodeId: string): SchedulerResult<true> {
    const node = this.dag.nodes[nodeId];
    if (!node) {
      return { ok: false, code: "NODE_NOT_FOUND", message: `Nœud "${nodeId}" introuvable` };
    }
    if (node.status !== "ASSIGNED" && node.status !== "RUNNING") {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: `Human gate requires ASSIGNED or RUNNING, got ${node.status}`,
      };
    }
    return { ok: true, data: true as const };
  }

  /**
   * Vérifie si un nœud peut recevoir une revue.
   */
  canReview(nodeId: string): SchedulerResult<true> {
    const node = this.dag.nodes[nodeId];
    if (!node) {
      return { ok: false, code: "NODE_NOT_FOUND", message: `Nœud "${nodeId}" introuvable` };
    }
    if (node.status !== "RUNNING") {
      return {
        ok: false,
        code: "NOT_RUNNING",
        message: `Le nœud "${nodeId}" est en état ${node.status}, pas RUNNING`,
      };
    }
    return { ok: true, data: true as const };
  }
}
