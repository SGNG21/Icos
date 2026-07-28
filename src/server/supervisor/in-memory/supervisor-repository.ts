import type {
  TaskDag,
  TaskNode,
  TaskNodeStatus,
  DagStatus,
  CreateDagInput,
} from "@/core/supervisor";
import {
  areAllDagNodesSuccessful,
  computeReadyNodes,
  isNodeTransitionAllowed,
} from "@/core/supervisor";
import type { SupervisorRepository } from "../ports";

/**
 * Repository Supervisor en mémoire.
 * Utilisé pour les tests et le développement local.
 */
export class InMemorySupervisorRepository implements SupervisorRepository {
  private readonly dags = new Map<string, TaskDag>();

  async createDag(input: CreateDagInput): Promise<TaskDag> {
    const now = new Date().toISOString();
    const nodes: Record<string, TaskNode> = {};

    for (const node of input.nodes) {
      nodes[node.id] = {
        ...node,
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      };
    }

    const dag: TaskDag = {
      id: input.id,
      missionId: input.missionId,
      tenantId: input.tenantId,
      status: "CREATED",
      nodes,
      nodeOrder: [],
      createdAt: now,
      updatedAt: now,
    };

    this.dags.set(dag.id, dag);
    return dag;
  }

  async findDagById(id: string): Promise<TaskDag | null> {
    return this.dags.get(id) ?? null;
  }

  async findDagsByMissionId(missionId: string): Promise<TaskDag[]> {
    return Array.from(this.dags.values()).filter((d) => d.missionId === missionId);
  }

  async findActiveDags(): Promise<TaskDag[]> {
    return Array.from(this.dags.values()).filter(
      (d) => d.status !== "COMPLETED" && d.status !== "FAILED" && d.status !== "CANCELLED",
    );
  }

  async updateDagStatus(dagId: string, status: DagStatus, error?: string): Promise<TaskDag | null> {
    const dag = this.dags.get(dagId);
    if (!dag) return null;

    // Garde fail-closed au point de mutation canonique. Un DAG terminal n'est
    // un succès que si CHAQUE nœud requis est lui-même SUCCEEDED.
    if (status === "COMPLETED" && !areAllDagNodesSuccessful(dag)) {
      return null;
    }

    // Idempotence : répéter un statut déjà persisté ne crée aucune mutation.
    if (dag.status === status) return dag;

    const now = new Date().toISOString();
    const updated: TaskDag = {
      ...dag,
      status,
      error: error ?? dag.error,
      updatedAt: now,
      completedAt:
        status === "COMPLETED" || status === "FAILED" || status === "CANCELLED"
          ? now
          : dag.completedAt,
    };

    this.dags.set(dagId, updated);
    return updated;
  }

  async addNode(dagId: string, node: TaskNode): Promise<TaskNode | null> {
    const dag = this.dags.get(dagId);
    if (!dag) return null;

    const now = new Date().toISOString();
    const newNode: TaskNode = {
      ...node,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    };

    const updated: TaskDag = {
      ...dag,
      nodes: { ...dag.nodes, [node.id]: newNode },
      updatedAt: now,
    };

    this.dags.set(dagId, updated);
    return newNode;
  }

  async updateNodeStatus(
    dagId: string,
    nodeId: string,
    status: TaskNodeStatus,
    updates?: Partial<TaskNode>,
  ): Promise<TaskNode | null> {
    const dag = this.dags.get(dagId);
    if (!dag) return null;

    const node = dag.nodes[nodeId];
    if (!node) return null;

    // Vérifier que la transition est autorisée
    if (!isNodeTransitionAllowed(node.status, status)) {
      return null;
    }

    const now = new Date().toISOString();
    const updatedNode: TaskNode = {
      ...node,
      ...updates,
      status,
      updatedAt: now,
      startedAt:
        status === "ASSIGNED" || status === "RUNNING" ? (node.startedAt ?? now) : node.startedAt,
      completedAt:
        status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED"
          ? now
          : node.completedAt,
    };

    const allNodes = { ...dag.nodes, [nodeId]: updatedNode };
    const allTerminal =
      (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED") &&
      Object.values(allNodes).every(
        (n) =>
          n.status === "SUCCEEDED" ||
          n.status === "FAILED" ||
          n.status === "CANCELLED" ||
          n.status === "BLOCKED",
      );

    const updated: TaskDag = {
      ...dag,
      nodes: allNodes,
      updatedAt: now,
      completedAt: allTerminal ? now : dag.completedAt,
    };

    this.dags.set(dagId, updated);
    return updatedNode;
  }

  async findNodeById(dagId: string, nodeId: string): Promise<TaskNode | null> {
    const dag = this.dags.get(dagId);
    if (!dag) return null;
    return dag.nodes[nodeId] ?? null;
  }

  /**
   * Calcule les ready-nodes pour un DAG donné.
   */
  getReadyNodes(dagId: string): string[] {
    const dag = this.dags.get(dagId);
    if (!dag) return [];
    return computeReadyNodes(dag);
  }
}
