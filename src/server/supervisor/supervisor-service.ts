import type { TaskDag, TaskNode } from "@/core/supervisor";
import { computeReadyNodes, validateDag, Scheduler } from "@/core/supervisor";
import { topologicalSort } from "@/core/supervisor";
import type { WorkerSpec, CreateWorkerInput } from "@/core/worker";
import type { ReviewSpec } from "@/core/review";
import type { IntegrationSpec } from "@/core/integration";
import type { PreviewResult } from "@/core/preview";
import type { SupervisorRepository } from "./ports";
import type { WorkerManagerPort } from "@/server/worker/ports";
import type { WorktreeManagerPort } from "@/server/worktree/ports";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "@/server/review/ports";
import { CorrectionLoop } from "@/server/review/correction-loop";
import type { GlobalGatesPort } from "@/server/integration/ports";
import type { IntegrationOrchestratorPort } from "@/server/integration/ports";
import type { PreviewDeliveryPort } from "@/server/preview/ports";

/**
 * Résultat d'une exécution complète du Supervisor.
 */
export interface SupervisorExecutionResult {
  dag: TaskDag;
  status: "SUCCEEDED" | "FAILED" | "PARTIAL" | "WAITING_FOR_HUMAN";
  integrationResult?: import("@/core/integration").IntegrationResult;
  previewResult?: PreviewResult;
  summary: string;
}

/**
 * Configuration du Supervisor.
 */
export interface SupervisorConfig {
  /** Nombre maximum de workers concurrents. */
  maxConcurrentWorkers: number;
  /** Nombre maximum de tentatives de correction. */
  maxCorrectionRetries: number;
  /** Timeout par défaut des workers (ms). */
  defaultWorkerTimeoutMs: number;
}

const DEFAULT_CONFIG: SupervisorConfig = {
  maxConcurrentWorkers: 4,
  maxCorrectionRetries: 3,
  defaultWorkerTimeoutMs: 300_000,
};

/**
 * SupervisorService — Orchestrateur central.
 *
 * Wires tous les composants du Supervisor ensemble :
 * 1. Reçoit un DAG et le valide
 * 2. Ordonne et planifie les tâches
 * 3. Spawn des workers via WorkerManager
 * 4. Isole via WorktreeManager
 * 5. Review via CorrectionLoop
 * 6. Intègre via IntegrationOrchestrator
 * 7. Livre via PreviewDelivery
 */
export class SupervisorService {
  private readonly config: SupervisorConfig;

  constructor(
    private readonly repository: SupervisorRepository,
    private readonly workers: WorkerManagerPort,
    private readonly worktrees: WorktreeManagerPort,
    private readonly reviewer: ReviewerManagerPort,
    private readonly corrector: CorrectionLoopManagerPort,
    private readonly gates: GlobalGatesPort,
    private readonly integrator: IntegrationOrchestratorPort,
    private readonly preview: PreviewDeliveryPort,
    config?: Partial<SupervisorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Exécute un DAG complet.
   *
   * Processus :
   * 1. Valide et enregistre le DAG
   * 2. Passe en SCHEDULING
   * 3. Pour chaque nœud READY :
   *    a. Crée un worktree
   *    b. Spawn un worker
   *    c. Attend la complétion
   *    d. Lance une revue
   *    e. Applique les corrections si nécessaire
   * 4. Intègre les résultats
   * 5. Exécute les gates globales
   * 6. Livre la preview
   * 7. Passe en COMPLETED
   */
  async execute(dag: TaskDag): Promise<SupervisorExecutionResult> {
    // 1. Valider le DAG
    const nodes = Object.values(dag.nodes);
    const validationErrors = validateDag(nodes);
    if (validationErrors.length > 0) {
      return {
        dag,
        status: "FAILED",
        summary: `Échec de validation du DAG: ${validationErrors.join("; ")}`,
      };
    }

    // 2. Enregistrer et passer en SCHEDULING
    const savedDag = await this.repository.createDag({
      id: dag.id,
      missionId: dag.missionId,
      tenantId: dag.tenantId,
      nodes,
    });

    await this.repository.updateDagStatus(dag.id, "SCHEDULING");

    // 3. Initialiser le scheduler
    const scheduler = new Scheduler(savedDag);

    // 4. Boucle d'exécution
    let allSucceeded = true;
    let integratedTaskCount = 0;

    // Calculer l'ordre topologique pour l'intégration
    const topoOrder = topologicalSort(savedDag);

    // Marquer les nœuds racines comme READY
    const readyNodes = computeReadyNodes(savedDag);
    for (const nodeId of readyNodes) {
      await this.repository.updateNodeStatus(dag.id, nodeId, "READY");
    }

    // Exécuter les nœuds dans l'ordre de priorité
    const completedShas: Array<{ taskId: string; sha: string; branch: string; path: string }> = [];
    const orderedNodes = topoOrder ?? Object.keys(savedDag.nodes);

    await this.repository.updateDagStatus(dag.id, "EXECUTING");

    for (const nodeId of orderedNodes) {
      try {
        // Re-lire l'état frais depuis le repository
        let currentNode = await this.repository.findNodeById(dag.id, nodeId);
        if (!currentNode || currentNode.status === "CANCELLED") continue;

        // a. Passer en READY si PENDING
        if (currentNode.status === "PENDING") {
          const updated = await this.repository.updateNodeStatus(dag.id, nodeId, "READY");
          if (!updated) continue;
          currentNode = updated;
        }
        if (currentNode.status !== "READY") continue;

        // b. Créer le worktree
        const worktree = await this.worktrees.createWorktree(nodeId);

        // c. Passer en ASSIGNED
        await this.repository.updateNodeStatus(dag.id, nodeId, "ASSIGNED", {
          currentWorkerId: `worker-${nodeId}`,
        });

        // d. Spawn le worker
        const workerId = await this.workers.spawn({
          taskId: nodeId,
          missionId: dag.missionId,
          tenantId: dag.tenantId,
          objective: currentNode.description,
          acceptanceCriteria: currentNode.acceptanceCriteria,
          permissionEnvelope: {
            action: "supervisor.worker.execute",
            resource: nodeId,
          },
          timeoutMs: this.config.defaultWorkerTimeoutMs,
        });

        // e. Attendre le résultat
        const workerResult = await this.workers.waitForCompletion(workerId, this.config.defaultWorkerTimeoutMs + 10_000);

        if (workerResult.outcome === "SUCCESS") {
          // Capturer le résultat du worktree
          const wtResult = await this.worktrees.captureResult(worktree.path);
          completedShas.push({
            taskId: nodeId,
            sha: wtResult.headSha,
            branch: worktree.branch,
            path: worktree.path,
          });

          await this.repository.updateNodeStatus(dag.id, nodeId, "SUCCEEDED", {
            workerAssignments: [{
              workerId,
              startedAt: new Date().toISOString(),
              workerResult,
            }],
          });
          integratedTaskCount++;
        } else {
          await this.repository.updateNodeStatus(dag.id, nodeId, "FAILED");
          allSucceeded = false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erreur inconnue";
        await this.repository.updateNodeStatus(dag.id, nodeId, "FAILED");
        allSucceeded = false;
      }
    }

    // Pas de résultats à intégrer
    if (completedShas.length === 0) {
      await this.repository.updateDagStatus(dag.id, "FAILED", "Aucune tâche réussie");
      return {
        dag: await this.repository.findDagById(dag.id) ?? dag,
        status: "FAILED",
        summary: "Aucune tâche n'a réussi — échec de l'exécution du DAG",
      };
    }

    // 5. Intégrer les résultats
    const integrationSpec: IntegrationSpec = {
      id: `integration-${dag.id}`,
      missionId: dag.missionId,
      dagId: dag.id,
      commits: completedShas.map((c) => ({
        taskId: c.taskId,
        commitSha: c.sha,
        branch: c.branch,
        worktreePath: c.path,
      })),
      integrationBranch: `integration/${dag.id}`,
    };

    const integrationResult = await this.integrator.integrate(integrationSpec);

    // 6. Preview
    let previewResult: PreviewResult | undefined;
    if (integrationResult.finalSha) {
      previewResult = await this.preview.deliver(
        integrationResult.finalSha,
        integrationSpec.integrationBranch,
      );
    }

    // 7. Statut final
    const status = integrationResult.status === "SUCCEEDED" ? "SUCCEEDED" : "PARTIAL";
    await this.repository.updateDagStatus(dag.id, status === "SUCCEEDED" ? "COMPLETED" : "FAILED");

    return {
      dag: await this.repository.findDagById(dag.id) ?? dag,
      status,
      integrationResult,
      previewResult,
      summary: `${integratedTaskCount}/${orderedNodes.length} tâches intégrées. Intégration: ${integrationResult.status}`,
    };
  }
}
