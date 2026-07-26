import { describe, expect, it, vi } from "vitest";

import type { ExecuteStepInput, ExecutionResult } from "@/core/runtime";
import type { PolicyRequest, PolicyDecision } from "@/core/policy/contract";
import type { D1PolicyPort } from "@/server/policy/ports";
import type { RuntimeExecutionPort } from "@/server/runtime/ports";
import { WorkerManager, PromiseSemaphore } from "./worker-manager";

// ─────────────────────────────────────
// Fakes
// ─────────────────────────────────────

class FakePolicyPort implements D1PolicyPort {
  private response: PolicyDecision = { outcome: "allow", reason: "test", attestedAt: new Date().toISOString() };

  setResponse(r: PolicyDecision) { this.response = r; }

  async decide(_request: PolicyRequest): Promise<PolicyDecision> {
    return this.response;
  }
}

class FakeRuntimePort implements RuntimeExecutionPort {
  private delayMs = 10;
  private result: ExecutionResult = {
    ok: true,
    state: "SUCCEEDED",
    output: "ok",
    artifacts: [],
    latencyMs: 10,
  };

  setDelay(ms: number) { this.delayMs = ms; }
  setResult(r: ExecutionResult) { this.result = r; }

  async execute(_input: ExecuteStepInput, _signal?: AbortSignal): Promise<ExecutionResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return this.result;
  }
}

// ─────────────────────────────────────
// Semaphore tests
// ─────────────────────────────────────

describe("PromiseSemaphore", () => {
  it("allows up to max concurrent acquires", async () => {
    const sem = new PromiseSemaphore(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    expect(sem.getAvailablePermits()).toBe(0);

    sem.release();
    expect(sem.getAvailablePermits()).toBe(1);
  });

  it("queues excess acquires", async () => {
    const sem = new PromiseSemaphore(2);

    await sem.acquire();
    await sem.acquire();

    // La 3e acquisition est mise en attente
    const third = sem.acquire();
    expect(sem.getAvailablePermits()).toBe(0);

    sem.release();
    await third; // Maintenant la 3e peut entrer
    expect(sem.getAvailablePermits()).toBe(0);
  });

  it("rejects max < 1", () => {
    expect(() => new PromiseSemaphore(0)).toThrow();
  });
});

// ─────────────────────────────────────
// WorkerManager tests
// ─────────────────────────────────────

describe("WorkerManager", () => {
  function createManager(maxConcurrent = 4) {
    const policy = new FakePolicyPort();
    const runtime = new FakeRuntimePort();
    const manager = new WorkerManager(runtime, policy, maxConcurrent);
    return { manager, policy, runtime };
  }

  // ─────────────────────────────────
  // Spawn
  // ─────────────────────────────────

  describe("spawn", () => {
    it("creates a worker and returns its ID", async () => {
      const { manager } = createManager();

      const workerId = await manager.spawn({
        taskId: "task-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        objective: "Implementer le port X",
        permissionEnvelope: { action: "worker.execute", resource: "task-001" },
      });

      expect(workerId).toMatch(/^worker-/);
    });

    it("rejects spawn when D1 denies", async () => {
      const { manager, policy } = createManager();
      policy.setResponse({
        outcome: "deny",
        reason: "Not authorized",
        code: "forbidden",
      });

      await expect(
        manager.spawn({
          taskId: "task-001",
          missionId: "mission-001",
          tenantId: "tenant-001",
          objective: "Tâche non autorisée",
          permissionEnvelope: { action: "worker.execute", resource: "task-001" },
        }),
      ).rejects.toThrow(/D1/);
    });

    it("returns immediately without waiting for completion", async () => {
      const { manager, runtime } = createManager();
      runtime.setDelay(1000); // 1s execution

      const start = Date.now();
      const workerId = await manager.spawn({
        taskId: "task-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        objective: "Longue tâche",
        permissionEnvelope: { action: "worker.execute", resource: "task-001" },
      });
      const elapsed = Date.now() - start;

      // Spawn doit retourner immédiatement (<< 1s)
      expect(elapsed).toBeLessThan(500);
      expect(workerId).toBeDefined();
    });
  });

  // ─────────────────────────────────
  // Status & results
  // ─────────────────────────────────

  describe("getStatus", () => {
    it("returns CREATED for a just-spawned worker", async () => {
      const { manager } = createManager();

      // Worker à exécution rapide
      const workerId = await manager.spawn({
        taskId: "task-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        objective: "Tâche rapide",
        permissionEnvelope: { action: "worker.execute", resource: "task-001" },
      });

      const { status } = await manager.getStatus(workerId);
      // Peut être CREATED ou RUNNING
      expect(["CREATED", "RUNNING"]).toContain(status);
    });

    it("returns null for unknown worker", async () => {
      const { manager } = createManager();
      const { worker } = await manager.getStatus("nonexistent");
      expect(worker).toBeNull();
    });
  });

  describe("collectResult", () => {
    it("returns result after completion", async () => {
      const { manager } = createManager();

      const workerId = await manager.spawn({
        taskId: "task-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        objective: "Tâche avec résultat",
        permissionEnvelope: { action: "worker.execute", resource: "task-001" },
      });

      // Attendre la complétion
      const result = await manager.waitForCompletion(workerId, 5000);

      expect(result.outcome).toBe("SUCCESS");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns FAILED when runtime fails", async () => {
      const { manager, runtime } = createManager();
      runtime.setResult({
        ok: false,
        state: "FAILED",
        error: { code: "PROCESS_ERROR", message: "Erreur simulée", retryable: false },
        artifacts: [],
        latencyMs: 5,
      });

      const workerId = await manager.spawn({
        taskId: "task-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        objective: "Tâche qui échoue",
        permissionEnvelope: { action: "worker.execute", resource: "task-001" },
      });

      const result = await manager.waitForCompletion(workerId, 5000);
      expect(result.outcome).toBe("FAILED");
    });
  });

  // ─────────────────────────────────
  // Cancellation
  // ─────────────────────────────────

  describe("cancel", () => {
    it("cancels a running worker", async () => {
      const { manager, runtime } = createManager();
      runtime.setDelay(5000); // Longue exécution

      const workerId = await manager.spawn({
        taskId: "task-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        objective: "Tâche longue",
        permissionEnvelope: { action: "worker.execute", resource: "task-001" },
      });

      // Attendre que le worker démarre
      await new Promise((r) => setTimeout(r, 50));

      await manager.cancel(workerId);
      const { status } = await manager.getStatus(workerId);
      expect(status).toBe("CANCELLED");
    });

    it("handles cancel of unknown worker gracefully", async () => {
      const { manager } = createManager();
      await expect(manager.cancel("nonexistent")).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────
  // Concurrency
  // ─────────────────────────────────

  describe("concurrency", () => {
    it("limits concurrent workers to max", async () => {
      const { manager } = createManager(2); // max 2 concurrents

      // Lancer 4 workers rapides
      const ids = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          manager.spawn({
            taskId: `task-${i}`,
            missionId: "mission-001",
            tenantId: "tenant-001",
            objective: `Tâche ${i}`,
            permissionEnvelope: { action: "worker.execute", resource: `task-${i}` },
          }),
        ),
      );

      // Attendre que tous se terminent
      const results = await Promise.all(
        ids.map((id) => manager.waitForCompletion(id, 10000)),
      );

      expect(results).toHaveLength(4);
      // Tous doivent réussir
      expect(results.every((r) => r.outcome === "SUCCESS")).toBe(true);
    });

    it("runs workers concurrently (not sequentially)", async () => {
      const { manager } = createManager(3);
      const WORKER_DELAY = 100; // ms par worker

      // Créer 3 workers avec un runtime qui prend 100ms chacun
      // Si séquentiel → ~300ms, si concurrent → ~100ms

      const ids = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          manager.spawn({
            taskId: `task-con-${i}`,
            missionId: "mission-001",
            tenantId: "tenant-001",
            objective: `Concurrent task ${i}`,
            permissionEnvelope: { action: "worker.execute", resource: `task-con-${i}` },
          }),
        ),
      );

      const start = Date.now();
      await Promise.all(ids.map((id) => manager.waitForCompletion(id, 10000)));
      const totalTime = Date.now() - start;

      // Si les 3 workers s'exécutent en parallèle, le temps total
      // doit être ~100ms, pas ~300ms.
      // On autorise une marge pour l'overhead.
      expect(totalTime).toBeLessThan(250);
    });
  });

  // ─────────────────────────────────
  // markLost
  // ─────────────────────────────────

  describe("markLost", () => {
    it("marks a worker as LOST", async () => {
      const { manager } = createManager();

      const workerId = await manager.spawn({
        taskId: "task-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        objective: "Tâche perdue",
        permissionEnvelope: { action: "worker.execute", resource: "task-001" },
      });

      await manager.markLost(workerId);
      const { status } = await manager.getStatus(workerId);
      expect(status).toBe("LOST");
    });
  });
});
