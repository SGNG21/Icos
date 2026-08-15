import { describe, expect, it } from "vitest";

import {
  artifactItemSchema,
  executionErrorCodeSchema,
  executionErrorSchema,
  executionResultSchema,
  executionStatusSchema,
  executeStepInputSchema,
  runtimeAdapterInputSchema,
  runtimeAdapterResultSchema,
  runtimeStateSchema,
  type ExecutionErrorCode,
  type ExecutionResult,
  type ExecuteStepInput,
  type RuntimeState,
} from "@/core/runtime";

// ─────────────────────────────────────
// Execution Status
// ─────────────────────────────────────

describe("D4 — executionStatusSchema", () => {
  it("accepte tous les statuts valides", () => {
    const valid = ["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "LOST"];
    for (const s of valid) {
      expect(() => executionStatusSchema.parse(s)).not.toThrow();
    }
  });

  it("rejette un statut invalide", () => {
    expect(() => executionStatusSchema.parse("INVALID")).toThrow();
  });

  it("rejette un statut vide", () => {
    expect(() => executionStatusSchema.parse("")).toThrow();
  });
});

// ─────────────────────────────────────
// Execution Error Code
// ─────────────────────────────────────

describe("D4 — executionErrorCodeSchema", () => {
  it("accepte tous les codes d'erreur valides", () => {
    const valid: ExecutionErrorCode[] = [
      "POLICY_DENIED",
      "REQUIRES_APPROVAL",
      "CREDENTIAL_UNAVAILABLE",
      "NETWORK_BLOCKED",
      "WORKSPACE_ERROR",
      "WORKSPACE_ESCAPE_DENIED",
      "PROCESS_ERROR",
      "TIMEOUT",
      "CANCELLED",
      "WORKER_LOST",
      "CLEANUP_ERROR",
      "INTERNAL_ERROR",
      "AI_PROVIDER_UNAVAILABLE",
      "AI_RATE_LIMITED",
      "AI_TIMEOUT",
      "AI_INVALID_RESPONSE",
      "AI_POLICY_BLOCKED",
      "AI_UNSUPPORTED_CAPABILITY",
      "AI_INTERNAL_ERROR",
    ];
    for (const code of valid) {
      expect(() => executionErrorCodeSchema.parse(code)).not.toThrow();
    }
  });

  it("rejette un code inconnu", () => {
    expect(() => executionErrorCodeSchema.parse("UNKNOWN_ERROR")).toThrow();
  });
});

// ─────────────────────────────────────
// Execution Error
// ─────────────────────────────────────

describe("D4 — executionErrorSchema", () => {
  it("valide un objet d'erreur complet", () => {
    const error = {
      code: "POLICY_DENIED",
      message: "Politique D1 refuse l'exécution",
      retryable: false,
    };
    const parsed = executionErrorSchema.parse(error);
    expect(parsed.code).toBe("POLICY_DENIED");
    expect(parsed.message).toBe("Politique D1 refuse l'exécution");
    expect(parsed.retryable).toBe(false);
  });

  it("défaut retryable à false", () => {
    const parsed = executionErrorSchema.parse({
      code: "INTERNAL_ERROR",
      message: "Erreur interne",
    });
    expect(parsed.retryable).toBe(false);
  });

  it("rejette un objet sans message", () => {
    expect(() => executionErrorSchema.parse({ code: "TIMEOUT" })).toThrow();
  });
});

// ─────────────────────────────────────
// Artifact
// ─────────────────────────────────────

describe("D4 — artifactItemSchema", () => {
  it("valide un artefact standard", () => {
    const parsed = artifactItemSchema.parse({
      name: "stdout",
      path: "output/stdout.log",
      size: 1024,
    });
    expect(parsed.name).toBe("stdout");
    expect(parsed.size).toBe(1024);
  });

  it("défaut size à 0", () => {
    const parsed = artifactItemSchema.parse({
      name: "empty",
      path: "output/empty.txt",
    });
    expect(parsed.size).toBe(0);
  });

  it("rejette un artefact sans nom", () => {
    expect(() => artifactItemSchema.parse({ path: "output.log" })).toThrow();
  });

  it("rejette un artefact sans path", () => {
    expect(() => artifactItemSchema.parse({ name: "log" })).toThrow();
  });
});

// ─────────────────────────────────────
// Execution Result
// ─────────────────────────────────────

describe("D4 — executionResultSchema (succès)", () => {
  it("valide un résultat succès minimum", () => {
    const result = {
      ok: true as const,
      state: "SUCCEEDED" as const,
      output: { message: "ok" },
      artifacts: [],
      latencyMs: 150,
    };
    const parsed = executionResultSchema.parse(result);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state).toBe("SUCCEEDED");
      expect(parsed.latencyMs).toBe(150);
    }
  });

  it("valide un résultat succès avec usage", () => {
    const result = {
      ok: true as const,
      state: "SUCCEEDED" as const,
      output: "done",
      artifacts: [],
      usage: {
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        costUsd: 0.05,
        providerId: "anthropic",
        model: "claude-sonnet-5",
        latencyMs: 500,
        fallbackUsed: false,
      },
      latencyMs: 500,
    };
    const parsed = executionResultSchema.parse(result);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.usage) {
      expect(parsed.usage.totalTokens).toBe(300);
    }
  });

  it("rejette un résultat succès avec état invalide", () => {
    expect(() =>
      executionResultSchema.parse({
        ok: true as const,
        state: "FAILED" as const,
        output: null,
        artifacts: [],
        latencyMs: 0,
      }),
    ).toThrow();
  });
});

describe("D4 — executionResultSchema (échec)", () => {
  it("valide un résultat d'échec", () => {
    const result = {
      ok: false as const,
      state: "FAILED" as const,
      error: { code: "PROCESS_ERROR", message: "Process crashed" },
      latencyMs: 200,
    };
    const parsed = executionResultSchema.parse(result);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("PROCESS_ERROR");
    }
  });

  it("valide un résultat annulé", () => {
    const result = {
      ok: false as const,
      state: "CANCELLED" as const,
      error: { code: "CANCELLED", message: "Cancelled by user" },
      latencyMs: 50,
    };
    const parsed = executionResultSchema.parse(result);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.state).toBe("CANCELLED");
    }
  });

  it("valide un timeout", () => {
    const result = {
      ok: false as const,
      state: "TIMED_OUT" as const,
      error: { code: "TIMEOUT", message: "Exceeded 60s timeout" },
      latencyMs: 60_000,
    };
    const parsed = executionResultSchema.parse(result);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.state).toBe("TIMED_OUT");
    }
  });

  it("valide un worker perdu", () => {
    const result = {
      ok: false as const,
      state: "LOST" as const,
      error: { code: "WORKER_LOST", message: "Process disappeared" },
      latencyMs: 0,
    };
    const parsed = executionResultSchema.parse(result);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.state).toBe("LOST");
    }
  });

  it("rejette un échec avec état SUCCEEDED", () => {
    expect(() =>
      executionResultSchema.parse({
        ok: false as const,
        state: "SUCCEEDED" as const,
        error: { code: "INTERNAL_ERROR", message: "bad" },
        latencyMs: 0,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────
// Execute Step Input
// ─────────────────────────────────────

describe("D4 — executeStepInputSchema", () => {
  it("valide un input standard", () => {
    const input: ExecuteStepInput = {
      missionId: "mission-123",
      tenantId: "tenant-1",
      runId: "run-abc",
      stepIndex: 0,
      stepDescription: "Analyser les logs",
      correlationId: "corr-xyz",
      timeoutMs: 60_000,
      hasExternalEffect: false,
    };
    const parsed = executeStepInputSchema.parse(input);
    expect(parsed.timeoutMs).toBe(60_000); // default
    expect(parsed.hasExternalEffect).toBe(false);
  });

  it("valide un input avec timeout personnalisé", () => {
    const input: ExecuteStepInput = {
      missionId: "mission-123",
      tenantId: "tenant-1",
      runId: "run-abc",
      stepIndex: 1,
      stepDescription: "Déployer",
      correlationId: "corr-xyz",
      timeoutMs: 300_000,
      hasExternalEffect: true,
    };
    const parsed = executeStepInputSchema.parse(input);
    expect(parsed.timeoutMs).toBe(300_000);
    expect(parsed.hasExternalEffect).toBe(true);
  });

  it("rejette un input sans missionId", () => {
    expect(() =>
      executeStepInputSchema.parse({
        tenantId: "tenant-1",
        runId: "run-abc",
        stepIndex: 0,
        stepDescription: "test",
        correlationId: "corr-xyz",
      }),
    ).toThrow();
  });

  it("rejette un input sans correlationId", () => {
    expect(() =>
      executeStepInputSchema.parse({
        missionId: "m-1",
        tenantId: "t-1",
        runId: "r-1",
        stepIndex: 0,
        stepDescription: "test",
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────
// Runtime State
// ─────────────────────────────────────

describe("D4 — runtimeStateSchema", () => {
  it("valide un état STARTING", () => {
    const state: RuntimeState = {
      runId: "run-1",
      missionId: "mission-1",
      tenantId: "tenant-1",
      correlationId: "corr-1",
      status: "STARTING",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = runtimeStateSchema.parse(state);
    expect(parsed.status).toBe("STARTING");
    expect(parsed.completedAt).toBeUndefined();
  });

  it("valide un état RUNNING avec workspace", () => {
    const state: RuntimeState = {
      runId: "run-1",
      missionId: "mission-1",
      tenantId: "tenant-1",
      correlationId: "corr-1",
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspacePath: "/tmp/icos/workspaces/t1/r1",
    };
    const parsed = runtimeStateSchema.parse(state);
    expect(parsed.workspacePath).toBe("/tmp/icos/workspaces/t1/r1");
  });

  it("valide un état SUCCEEDED avec completedAt", () => {
    const now = new Date().toISOString();
    const state: RuntimeState = {
      runId: "run-1",
      missionId: "mission-1",
      tenantId: "tenant-1",
      correlationId: "corr-1",
      status: "SUCCEEDED",
      startedAt: now,
      updatedAt: now,
      completedAt: now,
    };
    const parsed = runtimeStateSchema.parse(state);
    expect(parsed.completedAt).toBe(now);
  });

  it("valide un état FAILED avec erreur", () => {
    const now = new Date().toISOString();
    const state: RuntimeState = {
      runId: "run-1",
      missionId: "mission-1",
      tenantId: "tenant-1",
      correlationId: "corr-1",
      status: "FAILED",
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      error: { code: "POLICY_DENIED", message: "Refusé", retryable: false },
    };
    const parsed = runtimeStateSchema.parse(state);
    expect(parsed.error?.code).toBe("POLICY_DENIED");
  });

  it("rejette un statut invalide du runtime", () => {
    expect(() =>
      runtimeStateSchema.parse({
        runId: "r-1",
        missionId: "m-1",
        tenantId: "t-1",
        correlationId: "c-1",
        status: "INVALID",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────
// Adapter Input / Result
// ─────────────────────────────────────

describe("D4 — runtimeAdapterInputSchema", () => {
  it("valide un input d'adaptateur standard", () => {
    const parsed = runtimeAdapterInputSchema.parse({
      runId: "run-1",
      missionId: "mission-1",
      tenantId: "tenant-1",
      correlationId: "corr-1",
      stepDescription: "Analyser",
      workspacePath: "/workspace/run-1",
      timeoutMs: 60_000,
    });
    expect(parsed.workspacePath).toBe("/workspace/run-1");
  });

  it("rejette un input sans workspacePath", () => {
    expect(() =>
      runtimeAdapterInputSchema.parse({
        runId: "r-1",
        missionId: "m-1",
        tenantId: "t-1",
        correlationId: "c-1",
        stepDescription: "test",
        timeoutMs: 60_000,
      }),
    ).toThrow();
  });
});

describe("D4 — runtimeAdapterResultSchema", () => {
  it("valide un résultat succès", () => {
    const parsed = runtimeAdapterResultSchema.parse({ ok: true, output: { data: "ok" } });
    expect(parsed.ok).toBe(true);
  });

  it("valide un résultat d'échec", () => {
    const parsed = runtimeAdapterResultSchema.parse({
      ok: false,
      errorCode: "PROCESS_ERROR",
      message: "Exit code 1",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errorCode).toBe("PROCESS_ERROR");
      expect(parsed.retryable).toBe(false); // default
    }
  });

  it("rejette un résultat d'échec sans message", () => {
    expect(() =>
      runtimeAdapterResultSchema.parse({
        ok: false as const,
        errorCode: "INTERNAL_ERROR",
      }),
    ).toThrow();
  });
});
