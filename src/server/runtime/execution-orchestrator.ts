import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  AiGenerationResult,
  AiRoutingRequestWithSignal,
} from "@/core/ai";
import type {
  ExecutionErrorCode,
  ExecutionResult,
  ExecutionStatus,
  ExecuteStepInput,
  RuntimeState,
  UsageMetadata,
} from "@/core/runtime";
import { isExecutionTransitionAllowed } from "@/core/runtime";
import type { AiGatewayPort } from "@/server/ai/ports";
import type { PolicyDecision } from "@/core/policy/contract";
import type { D1PolicyPort } from "@/server/policy/ports";

import type { AgentRuntimeAdapter } from "./adapters/runtime-adapter";
import { LocalRuntimeAdapter } from "./adapters/local-runtime-adapter";
import { ArtifactCollector } from "./artifact-collector";
import { createExecutionError, mapAiErrorToExecutionError } from "./errors";
import type {
  CredentialBrokerPort,
  NetworkDecision,
  NetworkPolicyPort,
} from "./ports";
import { WorkspaceManager } from "./workspace-manager";

/**
 * Résultat du parse d'une exécution (non exporté).
 */
type ExecutionOutcome = {
  finalStatus: ExecutionStatus;
  result: ExecutionResult;
};

/**
 * Orchestrateur central D4.
 *
 * Coordonne l'ensemble du cycle de vie d'une exécution :
 *
 * 1. Réception ExecuteStepInput
 * 2. Re-vérification D1 (pas de stale planning-time)
 * 3. Création de l'état STARTING
 * 4. Résolution workspace
 * 5. Résolution credentials
 * 6. Vérification réseau
 * 7. Résolution adaptateur
 * 8. Transition RUNNING
 * 9. Exécution via adaptateur
 * 10. Collecte artefacts
 * 11. Nettoyage workspace
 * 12. Retour du résultat final
 *
 * INVARIANTS :
 * - La politique D1 est toujours re-vérifiée avant exécution (SEC-D4-07)
 * - Les transitions illégales sont refusées (fail-closed)
 * - Le workspace est toujours nettoyé après exécution
 * - Les credentials ne sont jamais exposés
 * - Tout timeout non rattrapable → TIMED_OUT
 * - Toute annulation → CANCELLED
 * - Toute erreur inconnue → INTERNAL_ERROR
 */
export class ExecutionOrchestrator implements RuntimeExecutionPort {
  // État interne — visible pour les tests
  private _state: RuntimeState | null = null;
  private startedAt = 0;

  constructor(
    private readonly policy: D1PolicyPort,
    private readonly aiGateway: AiGatewayPort,
    private readonly workspaceManager: WorkspaceManager,
    private readonly artifactCollector: ArtifactCollector,
    private readonly credentialBroker: CredentialBrokerPort,
    private readonly networkPolicy: NetworkPolicyPort,
    private readonly adapters: Map<string, AgentRuntimeAdapter> = new Map(),
  ) {
    // Enregistrer l'adaptateur local par défaut
    if (!this.adapters.has("local")) {
      this.adapters.set("local", new LocalRuntimeAdapter());
    }
  }

  /**
   * Retourne l'état interne actuel (pour tests).
   */
  get state(): RuntimeState | null {
    return this._state;
  }

  /**
   * Point d'entrée D4 — exécute une étape de plan.
   */
  async execute(input: ExecuteStepInput, signal?: AbortSignal): Promise<ExecutionResult> {
    this.startedAt = Date.now();

    const outcome = await this.runExecution(input, signal);

    // S'assurer que le workspace est nettoyé dans tous les cas
    await this.tryCleanupWorkspace();

    return outcome.result;
  }

  /**
   * Boucle principale d'exécution.
   */
  private async runExecution(
    input: ExecuteStepInput,
    externalSignal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
    // ── Phase 1 : D1 re-check (SEC-D4-07) ──
    const policyDecision = await this.recheckPolicy(input);

    if (policyDecision.outcome === "deny") {
      return this.fail("POLICY_DENIED", `Politique D1 refuse l'exécution: ${policyDecision.reason}`);
    }
    if (policyDecision.outcome === "require_approval") {
      return this.fail(
        "REQUIRES_APPROVAL",
        `L'exécution nécessite une approbation: ${policyDecision.reason}`,
      );
    }

    // ── Phase 2 : STARTING ──
    if (!this.transitionTo("STARTING")) {
      return this.internalError("Impossible de créer l'état STARTING");
    }

    // ── Phase 3 : Workspace ──
    let workspacePath: string;
    try {
      workspacePath = await this.workspaceManager.createWorkspace(
        input.tenantId,
        input.runId,
      );
      this._state!.workspacePath = workspacePath;
    } catch (error) {
      return this.fail(
        "WORKSPACE_ERROR",
        `Impossible de créer le workspace: ${error instanceof Error ? error.message : "erreur inconnue"}`,
      );
    }

    // ── Phase 4 : Credentials ──
    const credentialResolution = await this.credentialBroker.resolve({
      tenantId: input.tenantId,
      missionId: input.missionId,
      runId: input.runId,
    });

    if (!credentialResolution.available) {
      return this.fail("CREDENTIAL_UNAVAILABLE", credentialResolution.message);
    }

    // ── Phase 5 : Network ──
    const networkDecision = await this.networkPolicy.check({
      tenantId: input.tenantId,
      missionId: input.missionId,
      runId: input.runId,
    });

    if (networkDecision.outcome === "deny") {
      // En V1, le réseau est par défaut DENY — ce n'est pas bloquant
      // pour l'exécution locale sans accès réseau.
      // On continue mais on note la décision.
    }

    // ── Phase 6 : Résolution adaptateur ──
    const adapter = this.resolveAdapter(input);
    if (!adapter) {
      return this.fail(
        "INTERNAL_ERROR",
        `Aucun adaptateur disponible pour l'étape "${input.stepDescription}"`,
      );
    }

    // ── Phase 7 : RUNNING ──
    if (!this.transitionTo("RUNNING")) {
      return this.internalError("Transition RUNNING refusée");
    }

    // ── Phase 8 : Exécution ──
    // AbortController interne : combine le timeout et un signal externe
    // (ex: annulation demandée par D2) en une seule source de vérité,
    // avec un `reason` distinguant les deux cas (SEC routage CANCELLED/TIMED_OUT).
    const abortController = new AbortController();

    const timeoutId = setTimeout(() => {
      abortController.abort("timeout");
    }, input.timeoutMs);

    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort("cancelled");
      } else {
        externalAbortHandler = () => abortController.abort("cancelled");
        externalSignal.addEventListener("abort", externalAbortHandler, {
          once: true,
        });
      }
    }

    const cleanupAbort = () => {
      clearTimeout(timeoutId);
      if (externalAbortHandler && externalSignal) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
      }
    };

    try {
      const adapterResult = await adapter.execute(
        {
          runId: input.runId,
          missionId: input.missionId,
          tenantId: input.tenantId,
          correlationId: input.correlationId,
          stepDescription: input.stepDescription,
          skillKey: input.skillKey,
          toolRef: input.toolRef,
          agentId: input.agentId,
          workspacePath,
          timeoutMs: input.timeoutMs,
        },
        abortController.signal,
      );

      cleanupAbort();

      // Gérer le résultat de l'adaptateur
      if (adapterResult.ok) {
        return await this.handleAdapterSuccess(adapterResult.output, input);
      }

      // L'adaptateur retourne ok:false même quand le process a été tué
      // suite à un abort (timeout ou annulation) — router en conséquence
      // plutôt que de traiter ça comme un échec normal (SEC-D4-05/06).
      if (abortController.signal.aborted) {
        if (abortController.signal.reason === "timeout") {
          return await this.handleTimeout(input);
        }
        return await this.handleCancellation(input);
      }

      // Échec adaptateur (non lié à un abort)
      return await this.handleAdapterError(
        adapterResult.errorCode,
        adapterResult.message,
        adapterResult.retryable,
        input,
      );
    } catch (error) {
      cleanupAbort();

      const message = error instanceof Error ? error.message : String(error);
      if (abortController.signal.aborted) {
        if (abortController.signal.reason === "timeout") {
          return await this.handleTimeout(input);
        }
        return await this.handleCancellation(input);
      }

      return await this.handleAdapterError(
        "PROCESS_ERROR",
        `Erreur d'exécution: ${message}`,
        false,
        input,
      );
    }
  }

  // ─────────────────────────────────────
  // Re-check D1 (SEC-D4-07)
  // ─────────────────────────────────────

  private async recheckPolicy(input: ExecuteStepInput): Promise<PolicyDecision> {
    return this.policy.decide({
      actor: {
        kind: "agent",
        id: input.agentId ?? "d4-runtime",
        tenantId: input.tenantId,
      },
      tenant: { tenantId: input.tenantId },
      action: "runtime.execute",
      resource: {
        type: "execution",
        id: input.runId,
        ownerTenantId: input.tenantId,
      },
      risk: input.hasExternalEffect ? "sensitive" : "reversible",
      hasExternalEffect: input.hasExternalEffect,
    });
  }

  // ─────────────────────────────────────
  // State management
  // ─────────────────────────────────────

  private transitionTo(target: ExecutionStatus): boolean {
    const current = this._state?.status;
    if (current && !isExecutionTransitionAllowed(current, target)) {
      return false;
    }

    const now = new Date().toISOString();

    if (!this._state) {
      this._state = {
        runId: "",
        missionId: "",
        tenantId: "",
        correlationId: "",
        status: target,
        startedAt: now,
        updatedAt: now,
      };
    } else {
      this._state = {
        ...this._state,
        status: target,
        updatedAt: now,
        completedAt:
          ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "LOST"].includes(
            target,
          )
            ? now
            : this._state.completedAt,
      };
    }

    return true;
  }

  // ─────────────────────────────────────
  // Succès (D3 intégré)
  // ─────────────────────────────────────

  private async handleAdapterSuccess(
    output: unknown,
    input: ExecuteStepInput,
  ): Promise<ExecutionOutcome> {
    // Collecter les artefacts
    const artifacts = this._state?.workspacePath
      ? await this.artifactCollector.collectFromWorkspace(
          this._state.workspacePath,
        )
      : [];

    // Tenter une génération AI si c'est une étape AI
    let usage: UsageMetadata | undefined;

    if (input.skillKey) {
      try {
        const aiResult = await this.callAiGateway(input);
        if (aiResult.success) {
          usage = {
            inputTokens: aiResult.usage.inputTokens,
            outputTokens: aiResult.usage.outputTokens,
            totalTokens: aiResult.usage.totalTokens,
            costUsd: aiResult.usage.costUsd,
            providerId: aiResult.provider.id,
            model: aiResult.provider.model,
            latencyMs: aiResult.latencyMs,
            fallbackUsed: aiResult.fallbackUsed,
          };
        }
      } catch {
        // Échec AI non bloquant pour le résultat d'exécution
      }
    }

    this.transitionTo("SUCCEEDED");

    return {
      finalStatus: "SUCCEEDED",
      result: {
        ok: true,
        state: "SUCCEEDED",
        output,
        artifacts,
        usage,
        latencyMs: Date.now() - this.startedAt,
      },
    };
  }

  // ─────────────────────────────────────
  // Gestion des erreurs
  // ─────────────────────────────────────

  private async handleAdapterError(
    errorCode: string,
    message: string,
    retryable: boolean,
    input: ExecuteStepInput,
  ): Promise<ExecutionOutcome> {
    // Collecter les artefacts avant l'échec
    const artifacts = this._state?.workspacePath
      ? await this.artifactCollector
          .collectFromWorkspace(this._state.workspacePath)
          .catch(() => [])
      : [];

    // Mapper le code d'erreur D4
    const error = createExecutionError(
      errorCode as Parameters<typeof createExecutionError>[0],
      message,
      retryable,
    );

    this.transitionTo("FAILED");

    return {
      finalStatus: "FAILED",
      result: {
        ok: false,
        state: "FAILED",
        error,
        latencyMs: Date.now() - this.startedAt,
        artifacts,
      },
    };
  }

  private async handleTimeout(input: ExecuteStepInput): Promise<ExecutionOutcome> {
    const artifacts = this._state?.workspacePath
      ? await this.artifactCollector
          .collectFromWorkspace(this._state.workspacePath)
          .catch(() => [])
      : [];

    this.transitionTo("TIMED_OUT");

    return {
      finalStatus: "TIMED_OUT",
      result: {
        ok: false,
        state: "TIMED_OUT",
        error: createExecutionError(
          "TIMEOUT",
          `Exécution dépassée (${input.timeoutMs}ms)`,
          false,
        ),
        latencyMs: Date.now() - this.startedAt,
        artifacts,
      },
    };
  }

  private async handleCancellation(input: ExecuteStepInput): Promise<ExecutionOutcome> {
    const artifacts = this._state?.workspacePath
      ? await this.artifactCollector
          .collectFromWorkspace(this._state.workspacePath)
          .catch(() => [])
      : [];

    this.transitionTo("CANCELLED");

    return {
      finalStatus: "CANCELLED",
      result: {
        ok: false,
        state: "CANCELLED",
        error: createExecutionError("CANCELLED", "Exécution annulée", false),
        latencyMs: Date.now() - this.startedAt,
        artifacts,
      },
    };
  }

  private async fail(
    code: ExecutionErrorCode,
    message: string,
  ): Promise<ExecutionOutcome> {
    if (this._state) {
      // Tenter collecte artefacts avant échec
      const artifacts = this._state.workspacePath
        ? await this.artifactCollector
            .collectFromWorkspace(this._state.workspacePath)
            .catch(() => [])
        : [];

      this.transitionTo("FAILED");

      return {
        finalStatus: "FAILED",
        result: {
          ok: false,
          state: "FAILED",
          error: createExecutionError(code, message, false),
          latencyMs: Date.now() - this.startedAt,
          artifacts,
        },
      };
    }

    // Pas d'état encore créé
    return {
      finalStatus: "FAILED",
      result: {
        ok: false,
        state: "FAILED",
        error: createExecutionError(code, message, false),
        latencyMs: Date.now() - this.startedAt,
        artifacts: [],
      },
    };
  }

  private internalError(message: string): Promise<ExecutionOutcome> {
    return this.fail("INTERNAL_ERROR", message);
  }

  // ─────────────────────────────────────
  // AI Gateway (D3 intégration)
  // ─────────────────────────────────────

  private async callAiGateway(
    input: ExecuteStepInput,
  ): Promise<AiGenerationResult> {
    const aiRequest: AiRoutingRequestWithSignal = {
      prompt: input.stepDescription,
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      intent: "BEST_REASONING",
      timeoutMs: 30_000,
      qualityThreshold: "standard",
      fallbackAllowed: false,
      modalite: "chat",
    };

    return this.aiGateway.generate(aiRequest);
  }

  // ─────────────────────────────────────
  // Adapter resolution
  // ─────────────────────────────────────

  private resolveAdapter(input: ExecuteStepInput): AgentRuntimeAdapter | undefined {
    // V1 : toujours LocalRuntimeAdapter
    // V2+ : résolution basée sur skillKey/toolRef/agentId
    return this.adapters.get("local");
  }

  // ─────────────────────────────────────
  // Workspace cleanup
  // ─────────────────────────────────────

  private async tryCleanupWorkspace(): Promise<void> {
    if (!this._state?.workspacePath) return;

    try {
      await this.workspaceManager.releaseWorkspace(this._state.workspacePath);
    } catch {
      // Le nettoyage ne doit pas faire échouer l'exécution
    }
  }
}

/**
 * Type d'export pour l'interface publique.
 */
export type RuntimeExecutionPort = import("./ports").RuntimeExecutionPort;
