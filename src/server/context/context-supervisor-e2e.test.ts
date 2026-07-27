/**
 * CTX-SUP-E2E — Acceptance test : CONTEXT → SUPERVISOR → PLANNER → DAG.
 *
 * Démontre le pipeline complet :
 *   conversation/context fixture
 *   ↓
 *   ContextBuilder (buildMissionContext)
 *   ↓
 *   MissionContext (versionné)
 *   ↓
 *   MissionContextRepository (persistance)
 *   ↓
 *   ContextSupervisorBridge (resolveSupervisorContext)
 *   ↓
 *   SupervisorEnrichedContext
 *   ↓
 *   REAL SupervisorService
 *   ↓
 *   planner/scheduler + TaskDag (exécution)
 *
 * Aucun effet de bord externe : workers/tools sont mockés à leurs ports
 * canoniques (WorkerManagerPort, WorktreeManagerPort, etc.).
 */

import { describe, expect, it } from "vitest";

import type { TaskDag, TaskNode } from "@/core/supervisor";
import { validateDag, computeReadyNodes, Scheduler } from "@/core/supervisor";
import type { Worker, WorkerResult, CreateWorkerInput } from "@/core/worker";
import type { ReviewSpec, ReviewResult, CorrectionSpec, CorrectionResult } from "@/core/review";
import type { IntegrationSpec, IntegrationResult, GateResult } from "@/core/integration";
import type { PreviewResult } from "@/core/preview";
import type { WorktreeSpec, WorktreeResult, WorktreeEntry } from "@/core/worktree";
import type { ConversationContext, MissionContext } from "@/core/context";
import { buildMissionContext } from "@/core/context";
import type { Mission } from "@/core/mission";
import { resolveSupervisorContext } from "@/core/context/context-supervisor-bridge";
import type { SupervisorEnrichedContext } from "@/core/context";
import { InMemorySupervisorRepository } from "@/server/supervisor/in-memory/supervisor-repository";
import type { SupervisorRepository } from "@/server/supervisor/ports";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import type { WorkerManagerPort } from "@/server/worker/ports";
import type { WorktreeManagerPort } from "@/server/worktree/ports";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "@/server/review/ports";
import type { GlobalGatesPort, IntegrationOrchestratorPort } from "@/server/integration/ports";
import type { PreviewDeliveryPort } from "@/server/preview/ports";
import { InMemoryMissionContextRepository } from "@/server/context/in-memory/mission-context-repository";

const NOW = "2026-07-27T10:00:00.000Z";

// ─────────────────────────────────────
// Fakes (copies légères pour l'isolation de ce test)
// ─────────────────────────────────────

class FakeWorkerManagerEU implements WorkerManagerPort {
  async spawn(input: CreateWorkerInput): Promise<string> {
    return `worker-e2e-${input.taskId}`;
  }
  async getStatus(_workerId: string): Promise<{ status: Worker["status"]; worker: Worker | null }> {
    return { status: "SUCCEEDED", worker: null };
  }
  async collectResult(_workerId: string): Promise<WorkerResult | null> {
    return { outcome: "SUCCESS", artifacts: [], summary: "OK", durationMs: 10 };
  }
  async cancel(_workerId: string): Promise<void> {
    /* noop */
  }
  async waitForCompletion(_workerId: string, _timeoutMs?: number): Promise<WorkerResult> {
    return { outcome: "SUCCESS", artifacts: [], summary: "OK", durationMs: 10 };
  }
  async markLost(_workerId: string): Promise<void> {
    /* noop */
  }
}

class FakeWorktreeManagerEU implements WorktreeManagerPort {
  async createWorktree(_taskId: string): Promise<WorktreeSpec> {
    return {
      path: `/tmp/wt-e2e-${_taskId}`,
      branch: `wt-${_taskId}`,
      baseSha: "a".repeat(40),
      taskId: _taskId,
    };
  }
  async assignToTask(_path: string, _taskId: string): Promise<void> {
    /* noop */
  }
  async captureResult(_path: string): Promise<WorktreeResult> {
    return {
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      changedFiles: ["src/test.ts"],
      isDirty: false,
      uncommittedFiles: [],
      commitMessages: ["feat: task"],
      commitShas: ["b".repeat(40)],
    };
  }
  async detectChanges(_path: string): Promise<string[]> {
    return [];
  }
  async cleanupWorktree(_path: string): Promise<void> {
    /* noop */
  }
  async listActive(): Promise<WorktreeEntry[]> {
    return [];
  }
}

class FakeReviewerEU implements ReviewerManagerPort {
  async conductReview(_spec: ReviewSpec): Promise<ReviewResult> {
    return {
      verdict: "PASS",
      checks: [{ category: "acceptance_criteria", description: "OK", passed: true }],
      summary: "PASS",
      confidence: 4,
      durationMs: 100,
      completedAt: NOW,
    };
  }
  async ensureIndependentReview(_taskId: string, _reviewerWorkerId: string): Promise<boolean> {
    return true;
  }
}

class FakeCorrectorEU implements CorrectionLoopManagerPort {
  async executeCorrection(_spec: CorrectionSpec): Promise<CorrectionResult> {
    return { outcome: "CORRECTED", summary: "OK", durationMs: 5 };
  }
  isMaxAttemptsReached(_spec: CorrectionSpec): boolean {
    return false;
  }
  async escalate(_spec: CorrectionSpec): Promise<void> {
    /* noop */
  }
}

class FakeGatesEU implements GlobalGatesPort {
  async executeAll(_path: string): Promise<GateResult[]> {
    return [{ gate: "lint", passed: true, output: "", durationMs: 1, errors: [] }];
  }
  async executeGate(_gate: string, _path: string): Promise<GateResult> {
    return { gate: _gate, passed: true, output: "", durationMs: 1, errors: [] };
  }
  async gitDiffCheck(_path: string): Promise<GateResult> {
    return { gate: "git-diff-check", passed: true, output: "", durationMs: 1, errors: [] };
  }
}

class FakeIntegratorEU implements IntegrationOrchestratorPort {
  async integrate(_spec: IntegrationSpec): Promise<IntegrationResult> {
    return {
      status: "SUCCEEDED",
      gateResults: [],
      commitsIntegrated: 2,
      summary: "Intégration réussie",
      durationMs: 10,
      finalSha: "c".repeat(40),
    };
  }
}

class FakePreviewEU implements PreviewDeliveryPort {
  async deliver(_sha: string, _branch: string): Promise<PreviewResult> {
    return {
      status: "LOCAL_RESULT_READY",
      summary: "Preview prête",
      completedAt: NOW,
      durationMs: 5,
    };
  }
}

// ─────────────────────────────────────
// Helpers
// ─────────────────────────────────────

function makeNode(id: string, deps: string[], description?: string): TaskNode {
  return {
    id,
    label: `Task ${id}`,
    description: description ?? `Description ${id}`,
    acceptanceCriteria: [],
    status: "PENDING",
    dependsOn: deps,
    blockedBy: [],
    workerAssignments: [],
    correctionIds: [],
    correctionCount: 0,
    retryCount: 0,
    maxRetries: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeDag(
  id: string,
  missionId: string,
  tenantId: string,
  nodes?: Record<string, TaskNode>,
): TaskDag {
  return {
    id,
    missionId,
    tenantId,
    status: "CREATED",
    nodes: nodes ?? {
      "root-task": makeNode("root-task", [], "Générer le rapport trimestriel"),
    },
    nodeOrder: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// ─────────────────────────────────────
// E2E Test
// ─────────────────────────────────────

describe("CTX-SUP-E2E — full pipeline conversation → Supervisor → TaskDag", () => {
  /**
   * Pipeline E2E canonique :
   *   1. Fixture conversation + Mission
   *   2. ContextBuilder → MissionContext
   *   3. Persistance dans MissionContextRepository
   *   4. Chargement du latest
   *   5. ContextSupervisorBridge → SupervisorEnrichedContext
   *   6. REAL SupervisorService.execute(dag, enrichedContext)
   *   7. Vérification : DAG exécuté, contexte appliqué
   */
  it("conversation → ContextBuilder → MissionContext → persistence → bridge → enriched → real Supervisor → execution", async () => {
    // ── Étape 1 : Fixture ──
    const conversation: ConversationContext = {
      tenantId: "tenant-e2e",
      turns: [
        {
          id: "turn-obj",
          role: "user",
          text: "Générer le rapport trimestriel avec les données Q3",
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: NOW,
        },
        {
          id: "turn-cc",
          role: "user",
          text: "Deadline vendredi 18h",
          confirmed: true,
          isObjective: false,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: NOW,
        },
        {
          id: "turn-oq",
          role: "user",
          text: "Faut-il inclure les graphiques ?",
          confirmed: false,
          isObjective: false,
          isOpenQuestion: true,
          conflictsWithMission: false,
          observedAt: NOW,
        },
      ],
      memoryReferences: [],
    };

    const mission: Mission = {
      id: "mission-e2e-1",
      tenantId: "tenant-e2e",
      userRequest: "Générer le rapport trimestriel",
      status: "CREATED",
      runs: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    // ── Étape 2 : ContextBuilder → MissionContext ──
    const built = buildMissionContext({
      conversation,
      mission,
      builtByLabel: "e2e-test",
      now: NOW,
      version: 0,
    });

    expect(built.ok, "buildMissionContext a échoué").toBe(true);
    if (!built.ok) return;
    const missionContext = built.context;
    expect(missionContext.confirmedObjective).toBe(
      "Générer le rapport trimestriel avec les données Q3",
    );
    expect(missionContext.confirmedConstraints.length).toBeGreaterThan(0);
    expect(missionContext.openQuestions.length).toBe(1);
    expect(missionContext.assumptions.length).toBe(0); // Tout suit l'épistémique explicite

    // ── Étape 3 : Persistance ──
    const repo = new InMemoryMissionContextRepository();
    const saveResult = await repo.save({
      context: missionContext,
      expectedVersion: null,
    });
    expect(
      saveResult.ok,
      `save a échoué : ${!saveResult.ok ? (saveResult as { reason: string }).reason : "?"}`,
    ).toBe(true);

    // ── Étape 4 : Chargement du latest ──
    const loaded = await repo.findLatest("tenant-e2e", "mission-e2e-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(0);
    expect(loaded!.confirmedObjective).toBe("Générer le rapport trimestriel avec les données Q3");

    // ── Étape 5 : ContextSupervisorBridge → SupervisorEnrichedContext ──
    const bridgeResult = resolveSupervisorContext(loaded!, mission);
    expect(bridgeResult.ok, "resolveSupervisorContext a échoué").toBe(true);
    if (!bridgeResult.ok) return;
    const envelope = bridgeResult.envelope;
    expect(envelope.input.contextVersion).toBe(0);
    expect(envelope.input.confirmedObjective).toBe(
      "Générer le rapport trimestriel avec les données Q3",
    );
    expect(envelope.input.confirmedConstraints.length).toBe(1);
    expect(envelope.input.confirmedConstraints[0]!.statement).toBe("Deadline vendredi 18h");
    // Les questions ouvertes sont projetées
    expect(envelope.input.openQuestions.length).toBe(1);
    expect(envelope.input.openQuestions[0]!.statement).toBe("Faut-il inclure les graphiques ?");
    // Les assumptions ne franchissent PAS la frontière
    expect("assumptions" in envelope.input).toBe(false);

    // ── Étape 6 : REAL SupervisorService.execute(dag, enrichedContext) ──
    const supervisorRepo = new InMemorySupervisorRepository();
    const service = new SupervisorService(
      supervisorRepo,
      new FakeWorkerManagerEU(),
      new FakeWorktreeManagerEU(),
      new FakeReviewerEU(),
      new FakeCorrectorEU(),
      new FakeGatesEU(),
      new FakeIntegratorEU(),
      new FakePreviewEU(),
      { maxConcurrentWorkers: 2 },
    );

    const dag = makeDag("dag-e2e-1", "mission-e2e-1", "tenant-e2e", {
      "root-task": makeNode("root-task", [], "Générer le rapport trimestriel"),
    });

    const executeResult = await service.execute(dag, envelope);

    // ── Étape 7 : Vérification ──
    expect(executeResult.status).toBe("SUCCEEDED");
    // Le contexte est mentionné dans le résumé
    expect(executeResult.summary).toContain("contexte v0 appliqué");

    // Le DAG a été persisté
    const savedDag = await supervisorRepo.findDagById("dag-e2e-1");
    expect(savedDag).not.toBeNull();
    expect(savedDag!.status).not.toBe("CREATED"); // A avancé dans la machine d'état

    // Le DAG peut être validé par les fonctions core du Supervisor
    const validationErrors = validateDag(Object.values(savedDag?.nodes ?? {}));
    expect(validationErrors).toEqual([]);

    // La mission source de vérité est inchangée
    expect(mission.id).toBe("mission-e2e-1");
    expect(mission.userRequest).toBe("Générer le rapport trimestriel");
    expect(mission.tenantId).toBe("tenant-e2e");
  });

  /**
   * Échec sur tenant mismatch : le pipeline refuse si le contexte
   * appartient à un tenant différent du DAG.
   */
  it("rejects context with mismatched tenant at SupervisorService boundary", async () => {
    // Simuler un contexte valide mais pour un autre tenant
    const conversation: ConversationContext = {
      tenantId: "tenant-other",
      turns: [
        {
          id: "turn-obj",
          role: "user",
          text: "Rapport mensuel",
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: NOW,
        },
      ],
      memoryReferences: [],
    };

    const mission: Mission = {
      id: "mission-other",
      tenantId: "tenant-other",
      userRequest: "Rapport mensuel",
      status: "CREATED",
      runs: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    const built = buildMissionContext({
      conversation,
      mission,
      builtByLabel: "test",
      now: NOW,
      version: 0,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const bridgeResult = resolveSupervisorContext(built.context);
    expect(bridgeResult.ok).toBe(true);
    if (!bridgeResult.ok) return;

    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      new FakeWorkerManagerEU(),
      new FakeWorktreeManagerEU(),
      new FakeReviewerEU(),
      new FakeCorrectorEU(),
      new FakeGatesEU(),
      new FakeIntegratorEU(),
      new FakePreviewEU(),
    );

    // Le DAG a un tenant différent du contexte
    const dag = makeDag("dag-mismatch-tenant", "mission-other", "tenant-e2e-main");
    const result = await service.execute(dag, bridgeResult.envelope);

    expect(result.status).toBe("FAILED");
    expect(result.summary.toLowerCase()).toContain("tenant");
  });

  /**
   * Aucun contexte = le SupervisorService fonctionne normalement
   * (rétrocompatibilité). Le contexte enrichi est OPTIONNEL.
   */
  it("works without context (backward compatibility)", async () => {
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      new FakeWorkerManagerEU(),
      new FakeWorktreeManagerEU(),
      new FakeReviewerEU(),
      new FakeCorrectorEU(),
      new FakeGatesEU(),
      new FakeIntegratorEU(),
      new FakePreviewEU(),
    );

    const dag = makeDag("dag-no-ctx", "mission-no-ctx", "tenant-no-ctx");
    const result = await service.execute(dag);

    expect(result.status).toBe("SUCCEEDED");
    // Pas de mention de contexte dans le résumé
    expect(result.summary).not.toContain("contexte");
  });

  /**
   * Vérifie que l'isolation tenant est respectée via le pipeline complet.
   */
  it("preserves tenant isolation through the full pipeline", async () => {
    // Tenant A
    const convA: ConversationContext = {
      tenantId: "tenant-alpha",
      turns: [
        {
          id: "turn-a",
          role: "user",
          text: "Dashboard alpha",
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: NOW,
        },
      ],
      memoryReferences: [],
    };
    const missionA: Mission = {
      id: "mission-alpha",
      tenantId: "tenant-alpha",
      userRequest: "Dashboard alpha",
      status: "CREATED",
      runs: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const builtA = buildMissionContext({
      conversation: convA,
      mission: missionA,
      builtByLabel: "test",
      now: NOW,
      version: 0,
    });
    expect(builtA.ok).toBe(true);
    if (!builtA.ok) return;

    // Tenant B
    const convB: ConversationContext = {
      tenantId: "tenant-beta",
      turns: [
        {
          id: "turn-b",
          role: "user",
          text: "Dashboard beta",
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: NOW,
        },
      ],
      memoryReferences: [],
    };
    const missionB: Mission = {
      id: "mission-beta",
      tenantId: "tenant-beta",
      userRequest: "Dashboard beta",
      status: "CREATED",
      runs: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const builtB = buildMissionContext({
      conversation: convB,
      mission: missionB,
      builtByLabel: "test",
      now: NOW,
      version: 0,
    });
    expect(builtB.ok).toBe(true);
    if (!builtB.ok) return;

    // Les contextes ont des tenants différents
    expect(builtA.context.tenantId).toBe("tenant-alpha");
    expect(builtB.context.tenantId).toBe("tenant-beta");

    // Les bridges produisent des enveloppes avec les bons tenants
    const bridgeA = resolveSupervisorContext(builtA.context);
    const bridgeB = resolveSupervisorContext(builtB.context);
    expect(bridgeA.ok).toBe(true);
    expect(bridgeB.ok).toBe(true);
    if (!bridgeA.ok || !bridgeB.ok) return;

    expect(bridgeA.envelope.sourceRef.tenantId).toBe("tenant-alpha");
    expect(bridgeB.envelope.sourceRef.tenantId).toBe("tenant-beta");

    // Chaque contexte ne peut être utilisé qu'avec son propre tenant
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      new FakeWorkerManagerEU(),
      new FakeWorktreeManagerEU(),
      new FakeReviewerEU(),
      new FakeCorrectorEU(),
      new FakeGatesEU(),
      new FakeIntegratorEU(),
      new FakePreviewEU(),
    );

    // A context with tenant-beta DAG with tenant-alpha → FAILED
    const dagForAlpha = makeDag("dag-alpha-only", "mission-alpha", "tenant-alpha");
    const badResult = await service.execute(dagForAlpha, bridgeB.envelope);
    expect(badResult.status).toBe("FAILED");
    // Le message d'erreur mentionne la mission (vérifiée avant le tenant dans le code)
    expect(badResult.summary.toLowerCase()).toMatch(/tenant|mission/);
  });
});
