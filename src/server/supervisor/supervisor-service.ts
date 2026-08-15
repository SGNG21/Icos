import type { TaskDag, TaskNode, TaskNodeStatus } from "@/core/supervisor";
import { areAllDagNodesSuccessful, computeReadyNodes, validateDag } from "@/core/supervisor";
import { topologicalSort } from "@/core/supervisor";
import type { ReviewSpec } from "@/core/review";
import type { IntegrationSpec } from "@/core/integration";
import type { PreviewResult } from "@/core/preview";
import type { SupervisorEnrichedContext } from "@/core/context";
import type { SupervisorRepository } from "./ports";
import type { WorkerManagerPort } from "@/server/worker/ports";
import type { WorktreeManagerPort } from "@/server/worktree/ports";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "@/server/review/ports";
import { CorrectionLoop, type CorrectionLoopResult } from "@/server/review/correction-loop";
import type { GlobalGatesPort } from "@/server/integration/ports";
import type { IntegrationOrchestratorPort } from "@/server/integration/ports";
import type { PreviewDeliveryPort } from "@/server/preview/ports";
import type { SystemAgent } from "@/core/policy";
import type { WorktreeResult } from "@/core/worktree";

export interface WorktreeCleanupEvidence {
  path: string;
  cleaned: boolean;
  error?: string;
}

export interface SupervisorTaskEvidence {
  workerResult?: import("@/core/worker").WorkerResult;
  worktreeResult?: WorktreeResult;
  reviewResult?: CorrectionLoopResult;
}

/**
 * Résultat d'une exécution complète du Supervisor.
 */
export interface SupervisorExecutionResult {
  dag: TaskDag;
  status: "SUCCEEDED" | "FAILED" | "PARTIAL" | "WAITING_FOR_HUMAN";
  integrationResult?: import("@/core/integration").IntegrationResult;
  previewResult?: PreviewResult;
  taskEvidence?: Record<string, SupervisorTaskEvidence>;
  cleanupEvidence?: WorktreeCleanupEvidence[];
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
  /**
   * Identité système du Supervisor pour les appels D1.
   * Créée au bootstrap (composition root), jamais auto-attribuée.
   * Propagée via CreateWorkerInput.agentIdentity → WorkerManager → D1 PolicyRequest.
   * Non définie = PermissionGate refuse par défaut (default-deny).
   *
   * @see SystemAgent
   */
  agentIdentity?: SystemAgent;
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
   * Read-only view of the exact executor owned by this Supervisor composition.
   * Mission and browser inputs never participate in its construction.
   */
  getExecutionIdentity(): SystemAgent | null {
    return this.config.agentIdentity ? structuredClone(this.config.agentIdentity) : null;
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
  async execute(
    dag: TaskDag,
    context?: SupervisorEnrichedContext,
  ): Promise<SupervisorExecutionResult> {
    const ownedWorktrees = new Set<string>();
    const taskEvidence: Record<string, SupervisorTaskEvidence> = {};

    try {
      const result = await this.executeInternal(dag, context, ownedWorktrees, taskEvidence);
      if (ownedWorktrees.size === 0) {
        return { ...result, taskEvidence };
      }

      const cleanupEvidence = await this.cleanupOwnedWorktrees(ownedWorktrees);
      const cleanupFailures = cleanupEvidence.filter((item) => !item.cleaned);
      return {
        ...result,
        taskEvidence,
        cleanupEvidence: [...(result.cleanupEvidence ?? []), ...cleanupEvidence],
        summary:
          cleanupFailures.length === 0
            ? result.summary
            : `${result.summary}; cleanup failures: ${cleanupFailures.map((item) => item.error).join("; ")}`,
      };
    } catch (error) {
      const originalMessage =
        error instanceof Error ? error.message : "Unexpected Supervisor error";
      const cleanupEvidence = await this.cleanupOwnedWorktrees(ownedWorktrees);
      const cleanupFailures = cleanupEvidence.filter((item) => !item.cleaned);
      const reason =
        cleanupFailures.length === 0
          ? originalMessage
          : `${originalMessage}; cleanup failures: ${cleanupFailures.map((item) => item.error).join("; ")}`;
      await this.repository.updateDagStatus(dag.id, "FAILED", reason).catch(() => null);
      return {
        dag: (await this.repository.findDagById(dag.id).catch(() => null)) ?? dag,
        status: "FAILED",
        taskEvidence,
        cleanupEvidence,
        summary: `Échec inattendu du Supervisor: ${reason}`,
      };
    }
  }

  private async executeInternal(
    dag: TaskDag,
    context: SupervisorEnrichedContext | undefined,
    ownedWorktrees: Set<string>,
    taskEvidence: Record<string, SupervisorTaskEvidence>,
  ): Promise<SupervisorExecutionResult> {
    // ── Valider le contexte si fourni ──
    if (context) {
      // Le contexte doit appartenir à la même mission et au même tenant.
      if (context.sourceRef.missionId !== dag.missionId) {
        return {
          dag,
          status: "FAILED",
          summary: `Conflit de contexte : la mission du contexte (${context.sourceRef.missionId}) ne correspond pas au DAG (${dag.missionId})`,
        };
      }
      if (context.sourceRef.tenantId !== dag.tenantId) {
        return {
          dag,
          status: "FAILED",
          summary: `Conflit de contexte : le tenant du contexte (${context.sourceRef.tenantId}) ne correspond pas au DAG (${dag.tenantId})`,
        };
      }
      // Le contexte est informatif, jamais autoritaire.
      // Les champs suivants NE SONT JAMAIS utilisés comme permission/approbation/grant :
      //   input.confirmedObjective — objectif canonique, l'autorité reste D1/G1
      //   input.confirmedConstraints — contraintes contextuelles, pas de décision allow
      //   input.openQuestions — questions ouvertes, pas d'approbation
      //   input.boundedSummary — résumé informatif
      //   input.memoryReferences — références mémoire, preuve seule
    }

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

    const schedulingDag = await this.repository.updateDagStatus(dag.id, "SCHEDULING");
    if (!schedulingDag) {
      return {
        dag: (await this.repository.findDagById(dag.id)) ?? dag,
        status: "FAILED",
        summary: "Transition du DAG vers SCHEDULING refusée",
      };
    }

    // 3. Boucle d'exécution
    let allSucceeded = true;
    let integratedTaskCount = 0;
    const failureMessages: string[] = [];
    const correctionLoop = new CorrectionLoop(this.reviewer, this.corrector, {
      maxAttempts: this.config.maxCorrectionRetries,
    });

    // Calculer l'ordre topologique pour l'intégration
    const topoOrder = topologicalSort(savedDag);

    // Marquer les nœuds racines comme READY
    const readyNodes = computeReadyNodes(savedDag);
    for (const nodeId of readyNodes) {
      const result = await this.repository.updateNodeStatus(dag.id, nodeId, "READY");
      if (!result) {
        await this.repository.updateDagStatus(
          dag.id,
          "FAILED",
          `Transition du nœud ${nodeId} vers READY refusée`,
        );
        return {
          dag: (await this.repository.findDagById(dag.id)) ?? dag,
          status: "FAILED",
          summary: `Transition du nœud ${nodeId} vers READY refusée`,
        };
      }
    }

    // Exécuter les nœuds dans l'ordre de priorité
    const completedShas: Array<{
      taskId: string;
      sha: string;
      baseSha: string;
      branch: string;
      path: string;
    }> = [];
    const orderedNodes = topoOrder ?? Object.keys(savedDag.nodes);

    const executingDag = await this.repository.updateDagStatus(dag.id, "EXECUTING");
    if (!executingDag) {
      await this.repository.updateDagStatus(
        dag.id,
        "FAILED",
        "Transition du DAG vers EXECUTING refusée",
      );
      return {
        dag: (await this.repository.findDagById(dag.id)) ?? dag,
        status: "FAILED",
        summary: "Transition du DAG vers EXECUTING refusée",
      };
    }

    for (const nodeId of orderedNodes) {
      try {
        // Re-lire l'état frais depuis le repository
        let currentNode = await this.repository.findNodeById(dag.id, nodeId);
        if (!currentNode || currentNode.status === "CANCELLED") continue;

        // a. Passer en READY si PENDING
        if (currentNode.status === "PENDING") {
          const updated = await this.repository.updateNodeStatus(dag.id, nodeId, "READY");
          if (!updated) {
            throw new Error(`Transition du nœud ${nodeId} vers READY refusée`);
          }
          currentNode = updated;
        }
        if (currentNode.status !== "READY") continue;

        // b. Créer le worktree
        let worktree;
        try {
          worktree = await this.worktrees.createWorktree(nodeId);
          ownedWorktrees.add(worktree.path);
        } catch (wtErr) {
          throw wtErr;
        }

        // c. Passer en ASSIGNED
        currentNode = await this.transitionNodeOrThrow(dag.id, nodeId, "ASSIGNED", {
          currentWorkerId: `worker-${nodeId}`,
        });

        // d. Spawn le worker
        // Le contexte enrichi (SupervisorEnrichedContext) est informatif et
        // NON autoritaire. Il peut supplémenter l'objective locale avec le
        // résumé borné, mais NE JAMAIS remplacer le DAG comme source de
        // vérité pour l'exécution, ni autoriser une action:
        //   - permissionEnvelope est inchangé, passe par D1
        //   - objective locale reste le descriptif du nœud
        //   - contexte ajouté comme info complémentaire uniquement
        const workerObjective = context
          ? `${currentNode.description}\n\n[Contexte Mission]\nObjectif : ${context.input.confirmedObjective}\nRésumé : ${context.input.boundedSummary}${context.input.confirmedConstraints.length > 0 ? `\nContraintes : ${context.input.confirmedConstraints.map((c) => c.statement).join("; ")}` : ""}`
          : currentNode.description;

        const workerId = await this.workers.spawn({
          taskId: nodeId,
          missionId: dag.missionId,
          tenantId: dag.tenantId,
          objective: workerObjective,
          acceptanceCriteria: currentNode.acceptanceCriteria,
          permissionEnvelope: {
            action: "supervisor.worker.execute",
            resource: nodeId,
          },
          // Propagate Supervisor's system agent identity to D1 via WorkerManager.
          // Created at the composition root — never derived from context (Context ≠ Permission).
          agentIdentity: this.config.agentIdentity,
          timeoutMs: this.config.defaultWorkerTimeoutMs,
          worktreePath: worktree.path,
        });

        // Le worker a été créé : le nœud entre canoniquement en exécution.
        currentNode = await this.transitionNodeOrThrow(dag.id, nodeId, "RUNNING", {
          currentWorkerId: workerId,
          workerAssignments: [
            {
              workerId,
              startedAt: new Date().toISOString(),
            },
          ],
        });

        // e. Attendre le résultat
        const workerResult = await this.workers.waitForCompletion(
          workerId,
          this.config.defaultWorkerTimeoutMs + 10_000,
        );
        taskEvidence[nodeId] = {
          ...taskEvidence[nodeId],
          workerResult,
        };
        if (workerResult.outcome === "SUCCESS") {
          // Capturer le résultat du worktree
          const wtResult = await this.worktrees.captureResult(worktree.path);
          taskEvidence[nodeId] = {
            ...taskEvidence[nodeId],
            worktreeResult: wtResult,
          };

          // Un succès worker doit passer par la revue canonique avant de
          // devenir un succès de nœud.
          currentNode = await this.transitionNodeOrThrow(dag.id, nodeId, "REVIEWING");

          const reviewSpec: ReviewSpec = {
            taskId: nodeId,
            missionId: dag.missionId,
            tenantId: dag.tenantId,
            objective: currentNode.description,
            acceptanceCriteria: currentNode.acceptanceCriteria,
            requiredChecks: [
              "acceptance_criteria",
              "tests",
              "scope",
              "security_boundaries",
              "architecture_boundaries",
            ],
            worktreePath: worktree.path,
            commitSha: wtResult.headSha,
          };
          const reviewResult = await correctionLoop.execute(reviewSpec, worktree.path);
          taskEvidence[nodeId] = {
            ...taskEvidence[nodeId],
            reviewResult,
          };

          if (reviewResult.finalVerdict !== "PASS") {
            await this.transitionNodeOrThrow(dag.id, nodeId, "FAILED", {
              reviewResult: reviewResult.finalVerdict.toLowerCase(),
            });
            allSucceeded = false;
            failureMessages.push(`Revue du nœud ${nodeId}: ${reviewResult.finalVerdict}`);
            continue;
          }

          for (const review of reviewResult.reviews) {
            const reviewerWorkerId = review.reviewerWorkerId;
            const isIndependent =
              reviewerWorkerId !== undefined &&
              (await this.reviewer.ensureIndependentReview(workerId, reviewerWorkerId));
            if (!isIndependent) {
              throw new Error(
                `Revue indépendante du nœud ${nodeId} non établie` +
                  ` (implémentateur: ${workerId}, reviewer: ${reviewerWorkerId ?? "inconnu"})`,
              );
            }
          }

          // Une correction peut modifier et recommitter le worktree. Recapturer
          // après la dernière revue garantit que l'intégration utilise le
          // commit effectivement revu, jamais le SHA antérieur à la correction.
          const reviewedWtResult = await this.worktrees.captureResult(worktree.path);
          taskEvidence[nodeId] = {
            ...taskEvidence[nodeId],
            worktreeResult: reviewedWtResult,
          };
          if (reviewedWtResult.isDirty) {
            throw new Error(
              `Worktree du nœud ${nodeId} modifié après revue sans commit intégrable`,
            );
          }

          await this.transitionNodeOrThrow(dag.id, nodeId, "SUCCEEDED", {
            reviewResult: "pass",
            workerAssignments: [
              {
                workerId,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                workerResult,
              },
            ],
          });

          // Le commit ne devient intégrable qu'après persistance du succès
          // canonique du nœud.
          completedShas.push({
            taskId: nodeId,
            sha: reviewedWtResult.headSha,
            baseSha: reviewedWtResult.baseSha,
            branch: worktree.branch,
            path: worktree.path,
          });
          integratedTaskCount++;
        } else {
          await this.transitionNodeOrThrow(dag.id, nodeId, "FAILED");
          allSucceeded = false;
          failureMessages.push(
            `Worker du nœud ${nodeId}: ${workerResult.outcome} — ${workerResult.summary}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erreur inconnue";
        allSucceeded = false;
        failureMessages.push(message);

        // Meilleur effort fail-closed : persister FAILED lorsque la transition
        // courante le permet, sans jamais masquer le rejet initial.
        const failedNode = await this.repository.updateNodeStatus(dag.id, nodeId, "FAILED");
        if (!failedNode) {
          failureMessages.push(`Impossible de persister FAILED pour le nœud ${nodeId}`);
        }
      }
    }

    // Aucun résultat partiel ne doit contourner l'état canonique des nœuds.
    const dagBeforeIntegration = await this.repository.findDagById(dag.id);
    const everyNodeSucceeded =
      dagBeforeIntegration !== null && areAllDagNodesSuccessful(dagBeforeIntegration);

    if (!allSucceeded || !everyNodeSucceeded || completedShas.length !== orderedNodes.length) {
      const reason = failureMessages.join("; ") || "Tous les nœuds requis ne sont pas SUCCEEDED";
      await this.repository.updateDagStatus(dag.id, "FAILED", reason);
      return {
        dag: (await this.repository.findDagById(dag.id)) ?? dag,
        status: "FAILED",
        summary: `Échec de l'exécution du DAG: ${reason}`,
      };
    }

    // 5. Intégrer les résultats
    const commonBaseShas = new Set(completedShas.map((commit) => commit.baseSha));
    if (commonBaseShas.size !== 1) {
      const reason = "Les worktrees de tâches ne partagent pas une base Git commune";
      await this.repository.updateDagStatus(dag.id, "FAILED", reason);
      return {
        dag: (await this.repository.findDagById(dag.id)) ?? dag,
        status: "FAILED",
        summary: `Intégration refusée: ${reason}`,
      };
    }
    const [commonBaseSha] = commonBaseShas;
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
      baseSha: commonBaseSha,
    };

    const integrationResult = await this.integrator.integrate(integrationSpec);

    if (integrationResult.status !== "SUCCEEDED") {
      await this.repository.updateDagStatus(
        dag.id,
        "FAILED",
        `Intégration: ${integrationResult.status}`,
      );
      return {
        dag: (await this.repository.findDagById(dag.id)) ?? dag,
        status: "FAILED",
        integrationResult,
        summary: `Intégration échouée: ${integrationResult.status}`,
      };
    }

    // Task worktrees are no longer needed once reviewed commits have been
    // integrated and their gate evidence is retained. Cleanup happens before
    // the DAG can become COMPLETED so a cleanup failure cannot fabricate a
    // canonical success.
    const cleanupEvidence = await this.cleanupOwnedWorktrees(ownedWorktrees);
    const cleanupFailures = cleanupEvidence.filter((item) => !item.cleaned);
    if (cleanupFailures.length > 0) {
      const cleanupReason = cleanupFailures
        .map((item) => item.error ?? `Cleanup failed for ${item.path}`)
        .join("; ");
      await this.repository.updateDagStatus(
        dag.id,
        "FAILED",
        `Nettoyage des worktrees: ${cleanupReason}`,
      );
      return {
        dag: (await this.repository.findDagById(dag.id)) ?? dag,
        status: "FAILED",
        integrationResult,
        cleanupEvidence,
        summary: `Intégration réussie mais nettoyage obligatoire échoué: ${cleanupReason}`,
      };
    }

    // 6. Preview
    let previewResult: PreviewResult | undefined;
    if (integrationResult.finalSha) {
      previewResult = await this.preview.deliver(
        integrationResult.finalSha,
        integrationSpec.integrationBranch,
      );
    }

    // 7. Statut final
    const completedDag = await this.repository.updateDagStatus(dag.id, "COMPLETED");
    if (!completedDag) {
      await this.repository.updateDagStatus(
        dag.id,
        "FAILED",
        "Finalisation COMPLETED refusée par le repository",
      );
      return {
        dag: (await this.repository.findDagById(dag.id)) ?? dag,
        status: "FAILED",
        integrationResult,
        previewResult,
        summary: "Finalisation du DAG refusée : état des nœuds incohérent",
      };
    }

    // Ajouter un indicateur de contexte utilisé (informatif, jamais autoritaire)
    const contextNote = context ? ` | contexte v${context.sourceRef.version} appliqué` : "";

    return {
      dag: completedDag,
      status: "SUCCEEDED",
      integrationResult,
      previewResult,
      cleanupEvidence,
      summary: `${integratedTaskCount}/${orderedNodes.length} tâches intégrées. Intégration: ${integrationResult.status}${contextNote}`,
    };
  }

  private async cleanupOwnedWorktrees(
    ownedWorktrees: Set<string>,
  ): Promise<WorktreeCleanupEvidence[]> {
    const evidence: WorktreeCleanupEvidence[] = [];
    for (const worktreePath of [...ownedWorktrees].reverse()) {
      try {
        await this.worktrees.cleanupWorktree(worktreePath);
        evidence.push({ path: worktreePath, cleaned: true });
      } catch (error) {
        evidence.push({
          path: worktreePath,
          cleaned: false,
          error: this.boundedError(error),
        });
      } finally {
        ownedWorktrees.delete(worktreePath);
      }
    }
    return evidence;
  }

  private boundedError(error: unknown): string {
    const message = error instanceof Error ? error.message : "Unknown cleanup error";
    return message.slice(0, 512);
  }

  private async transitionNodeOrThrow(
    dagId: string,
    nodeId: string,
    targetStatus: TaskNodeStatus,
    updates?: Partial<TaskNode>,
  ): Promise<TaskNode> {
    const updated = await this.repository.updateNodeStatus(dagId, nodeId, targetStatus, updates);
    if (!updated) {
      const current = await this.repository.findNodeById(dagId, nodeId);
      throw new Error(
        `Transition du nœud ${nodeId} vers ${targetStatus} refusée` +
          ` (état courant: ${current?.status ?? "introuvable"})`,
      );
    }
    return updated;
  }
}
