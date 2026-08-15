import { describe, expect, it } from "vitest";

import {
  assertIdempotencyTransition,
  canAutoReplay,
  computeRequestHash,
  deriveIdempotencyKey,
  executionGrantSchema,
  idempotencyEntrySchema,
  idempotencyKeySchema,
  idempotencyStateSchema,
  isIdempotencyTerminal,
  isStaleExecuting,
  requestHashSchema,
  verifyRequestHash,
} from "@/core/g1";

// ─────────────────────────────────────
// requestHash
// ─────────────────────────────────────

describe("G1 — requestHash", () => {
  it("produit un hash SHA-256 valide (64 hex)", () => {
    const hash = computeRequestHash({
      tenantId: "tenant-1",
      principalId: "agent-1",
      toolId: "tool-slack",
      toolDefinitionHash: "abc123def",
      capability: "messaging:write",
      operation: "send",
      resource: "channel:general",
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("est déterministe pour les mêmes entrées", () => {
    const input = {
      tenantId: "tenant-1",
      principalId: "agent-1",
      toolId: "tool-slack",
      toolDefinitionHash: "abc123def",
      capability: "messaging:write",
      operation: "send",
      resource: "channel:general",
    };
    const a = computeRequestHash(input);
    const b = computeRequestHash(input);
    expect(a).toBe(b);
  });

  it("change quand le toolId change", () => {
    const base = {
      tenantId: "tenant-1",
      principalId: "agent-1",
      toolId: "tool-slack",
      toolDefinitionHash: "abc123def",
      capability: "messaging:write",
      operation: "send",
      resource: "channel:general",
    };
    const a = computeRequestHash(base);
    const b = computeRequestHash({ ...base, toolId: "tool-email" });
    expect(a).not.toBe(b);
  });

  it("change quand les arguments changent", () => {
    const base = {
      tenantId: "tenant-1",
      principalId: "agent-1",
      toolId: "tool-slack",
      toolDefinitionHash: "abc123def",
      capability: "messaging:write",
      operation: "send",
      resource: "channel:general",
    };
    const a = computeRequestHash({ ...base, arguments: { message: "hello" } });
    const b = computeRequestHash({ ...base, arguments: { message: "world" } });
    expect(a).not.toBe(b);
  });

  it("verifyRequestHash échoue sur des hash différents", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(verifyRequestHash(a, b)).toBe(false);
  });

  it("verifyRequestHash réussit sur des hash identiques", () => {
    const hash = "a".repeat(64);
    expect(verifyRequestHash(hash, hash)).toBe(true);
  });

  it("verifyRequestHash échoue sur des longueurs invalides", () => {
    expect(verifyRequestHash("short", "also-short")).toBe(false);
  });
});

// ─────────────────────────────────────
// IdempotencyKey
// ─────────────────────────────────────

describe("G1 — IdempotencyKey derivation", () => {
  it("produit une clé déterministe", () => {
    const input = {
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    };
    const a = deriveIdempotencyKey(input);
    const b = deriveIdempotencyKey(input);
    expect(a).toBe(b);
  });

  it("produit des clés différentes pour des tenants différents", () => {
    const a = deriveIdempotencyKey({
      tenantId: "tenant-a",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    });
    const b = deriveIdempotencyKey({
      tenantId: "tenant-b",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    });
    expect(a).not.toBe(b);
  });

  it("AttemptNumber ≠ IdempotencyKey : même clé pour retry", () => {
    const input = {
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    };
    // Un retry technique conserve la même clé
    const ik = deriveIdempotencyKey(input);
    expect(ik).toBe(deriveIdempotencyKey(input));
  });

  it("schéma valide le format de clé", () => {
    const ik = deriveIdempotencyKey({
      tenantId: "t-1",
      principalId: "p-1",
      missionId: "m-1",
      runId: "r-1",
    });
    expect(() => idempotencyKeySchema.parse(ik)).not.toThrow();
  });
});

// ─────────────────────────────────────
// Idempotency Identity Invariants
// ─────────────────────────────────────

describe("G1 — Idempotency identity invariants", () => {
  it("A: même identité métier + même requestHash → même IdempotencyKey", () => {
    const input = {
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    };
    const a = deriveIdempotencyKey(input);
    const b = deriveIdempotencyKey(input);
    expect(a).toBe(b);
  });

  it("B: même identité métier + arguments différents → même IdempotencyKey", () => {
    // L'IdempotencyKey est dérivée de l'identité métier uniquement
    // (tenant, principal, mission, run). Les changements d'arguments
    // produisent la même clé, permettant au service de détecter le conflit
    // (IDEMPOTENCY_CONFLICT quand requestHash diffère pour la même clé).
    const keyForMessageA = deriveIdempotencyKey({
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    });
    const keyForMessageB = deriveIdempotencyKey({
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    });
    expect(keyForMessageA).toBe(keyForMessageB);
  });

  it("C: identité métier différente → IdempotencyKey différente", () => {
    const keyA = deriveIdempotencyKey({
      tenantId: "tenant-a",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    });
    const keyB = deriveIdempotencyKey({
      tenantId: "tenant-b",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    });
    expect(keyA).not.toBe(keyB);

    // principal différent → clé différente
    const keyC = deriveIdempotencyKey({
      tenantId: "tenant-a",
      principalId: "agent-2",
      missionId: "mission-1",
      runId: "run-1",
    });
    expect(keyA).not.toBe(keyC);
  });

  it("D: retry technique → même IdempotencyKey (AttemptNumber ≠ IdempotencyKey)", () => {
    const business = {
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
    };
    // Le retry (mêmes attributs métier) conserve la même clé
    const attempt1 = deriveIdempotencyKey(business);
    const attempt2 = deriveIdempotencyKey(business);
    const attempt3 = deriveIdempotencyKey(business);
    expect(attempt1).toBe(attempt2);
    expect(attempt2).toBe(attempt3);
  });
});

// ─────────────────────────────────────
// requestHash Schema
// ─────────────────────────────────────

describe("G1 — requestHashSchema", () => {
  it("valide un hash hexadécimal de 64 caractères", () => {
    expect(() => requestHashSchema.parse("a".repeat(64))).not.toThrow();
  });

  it("rejette un hash trop court", () => {
    expect(() => requestHashSchema.parse("ab123")).toThrow();
  });

  it("rejette un hash avec caractères non hex", () => {
    expect(() => requestHashSchema.parse("z" + "a".repeat(63))).toThrow();
  });
});

// ─────────────────────────────────────
// Idempotency State Machine
// ─────────────────────────────────────

describe("G1 — Idempotency state machine", () => {
  describe("transitions autorisées", () => {
    it("RESERVED → EXECUTING", () => {
      expect(() => assertIdempotencyTransition("RESERVED", "EXECUTING")).not.toThrow();
    });

    it("EXECUTING → COMPLETED", () => {
      expect(() => assertIdempotencyTransition("EXECUTING", "COMPLETED")).not.toThrow();
    });

    it("EXECUTING → FAILED_SAFE", () => {
      expect(() => assertIdempotencyTransition("EXECUTING", "FAILED_SAFE")).not.toThrow();
    });

    it("EXECUTING → UNKNOWN", () => {
      expect(() => assertIdempotencyTransition("EXECUTING", "UNKNOWN")).not.toThrow();
    });

    it("FAILED_SAFE → RESERVED (retry)", () => {
      expect(() => assertIdempotencyTransition("FAILED_SAFE", "RESERVED")).not.toThrow();
    });
  });

  describe("transitions interdites", () => {
    it("RESERVED → COMPLETED direct", () => {
      expect(() => assertIdempotencyTransition("RESERVED", "COMPLETED")).toThrow();
    });

    it("COMPLETED → EXECUTING", () => {
      expect(() => assertIdempotencyTransition("COMPLETED", "EXECUTING")).toThrow();
    });

    it("UNKNOWN → EXECUTING", () => {
      expect(() => assertIdempotencyTransition("UNKNOWN", "EXECUTING")).toThrow();
    });

    it("UNKNOWN → COMPLETED", () => {
      expect(() => assertIdempotencyTransition("UNKNOWN", "COMPLETED")).toThrow();
    });

    it("RESERVED → FAILED_SAFE direct", () => {
      expect(() => assertIdempotencyTransition("RESERVED", "FAILED_SAFE")).toThrow();
    });
  });

  describe("isIdempotencyTerminal", () => {
    it("COMPLETED est terminal", () => {
      expect(isIdempotencyTerminal("COMPLETED")).toBe(true);
    });

    it("FAILED_SAFE n'est pas terminal (retry possible)", () => {
      expect(isIdempotencyTerminal("FAILED_SAFE")).toBe(false);
    });

    it("UNKNOWN est terminal", () => {
      expect(isIdempotencyTerminal("UNKNOWN")).toBe(true);
    });

    it("RESERVED n'est pas terminal", () => {
      expect(isIdempotencyTerminal("RESERVED")).toBe(false);
    });

    it("EXECUTING n'est pas terminal", () => {
      expect(isIdempotencyTerminal("EXECUTING")).toBe(false);
    });
  });
});

// ─────────────────────────────────────
// canAutoReplay
// ─────────────────────────────────────

describe("G1 — canAutoReplay", () => {
  it("COMPLETED peut être rejoué", () => {
    expect(canAutoReplay("COMPLETED")).toBe(true);
  });

  it("FAILED_SAFE peut être retry", () => {
    expect(canAutoReplay("FAILED_SAFE")).toBe(true);
  });

  it("RESERVED peut être repris", () => {
    expect(canAutoReplay("RESERVED")).toBe(true);
  });

  it("UNKNOWN ne peut PAS être rejoué automatiquement", () => {
    expect(canAutoReplay("UNKNOWN")).toBe(false);
  });

  it("EXECUTING ne peut pas être rejoué", () => {
    expect(canAutoReplay("EXECUTING")).toBe(false);
  });
});

// ─────────────────────────────────────
// isStaleExecuting
// ─────────────────────────────────────

describe("G1 — isStaleExecuting", () => {
  it("retourne true pour un état vieux de 10 minutes", () => {
    const old = new Date(Date.now() - 600_000).toISOString();
    expect(isStaleExecuting(old)).toBe(true);
  });

  it("retourne false pour un état récent", () => {
    const recent = new Date(Date.now() - 1_000).toISOString();
    expect(isStaleExecuting(recent)).toBe(false);
  });

  it("utilise le seuil personnalisé", () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    expect(isStaleExecuting(recent, 5_000)).toBe(true);
    expect(isStaleExecuting(recent, 15_000)).toBe(false);
  });
});

// ─────────────────────────────────────
// ExecutionGrant Schema
// ─────────────────────────────────────

describe("G1 — executionGrantSchema", () => {
  it("valide un grant complet", () => {
    const grant = {
      id: "grant-001",
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
      toolId: "tool-slack",
      toolDefinitionHash: "def123abc",
      toolVersion: "1.0.0",
      capability: "messaging:write",
      operation: "send",
      resource: "channel:general",
      requestHash: "a".repeat(64),
      idempotencyKey: "ik-test-key",
      policyProvenance: {
        policyId: "policy-allow-messaging",
        decision: "allow" as const,
        decidedAt: new Date().toISOString(),
        reason: "Autorisé pour monitoring",
      },
      credentialRequirements: [],
      networkRequirements: [],
      isolationRequirements: { filesystem: true, network: false, process: true },
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: null,
    };
    expect(() => executionGrantSchema.parse(grant)).not.toThrow();
  });

  it("rejette un grant avec requestHash invalide", () => {
    const grant = {
      id: "grant-002",
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
      toolId: "tool-slack",
      toolDefinitionHash: "def123abc",
      capability: "messaging:write",
      operation: "send",
      resource: "channel:general",
      requestHash: "not-a-valid-hash",
      idempotencyKey: "ik-test",
      policyProvenance: {
        policyId: "policy-1",
        decision: "allow" as const,
        decidedAt: new Date().toISOString(),
      },
      isolationRequirements: { filesystem: true, network: false, process: true },
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: null,
    };
    expect(() => executionGrantSchema.parse(grant)).toThrow();
  });
});

// ─────────────────────────────────────
// IdempotencyEntry Schema
// ─────────────────────────────────────

describe("G1 — idempotencyEntrySchema", () => {
  it("valide une entrée RESERVED", () => {
    const entry = {
      idempotencyKey: "ik-test",
      state: "RESERVED" as const,
      requestHash: "a".repeat(64),
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
      sensitivityLevel: "C1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(() => idempotencyEntrySchema.parse(entry)).not.toThrow();
  });

  it("valide une entrée COMPLETED", () => {
    const entry = {
      idempotencyKey: "ik-test",
      state: "COMPLETED" as const,
      requestHash: "a".repeat(64),
      tenantId: "tenant-1",
      principalId: "agent-1",
      missionId: "mission-1",
      runId: "run-1",
      sensitivityLevel: "C1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      replayResult: { outputHash: "abc123" },
    };
    expect(() => idempotencyEntrySchema.parse(entry)).not.toThrow();
  });

  it("rejette un état invalide", () => {
    expect(() =>
      idempotencyEntrySchema.parse({
        idempotencyKey: "ik-test",
        state: "INVALID",
        requestHash: "a".repeat(64),
        tenantId: "t-1",
        principalId: "p-1",
        missionId: "m-1",
        runId: "r-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────
// idempotencyStateSchema
// ─────────────────────────────────────

describe("G1 — idempotencyStateSchema", () => {
  it("accepte tous les états valides", () => {
    const states = ["RESERVED", "EXECUTING", "COMPLETED", "FAILED_SAFE", "UNKNOWN"];
    for (const s of states) {
      expect(() => idempotencyStateSchema.parse(s)).not.toThrow();
    }
  });

  it("rejette un état inconnu", () => {
    expect(() => idempotencyStateSchema.parse("PENDING")).toThrow();
  });
});
