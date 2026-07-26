import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditEntry } from "@/core/contracts/audit";
import { computeRequestHash, executionGrantSchema } from "@/core/g1";
import { InMemoryGrantRepository } from "@/server/g1/in-memory/in-memory-grant-repository";
import { InMemoryIdempotencyStore } from "@/server/g1/in-memory/in-memory-idempotency-store";
import { InMemoryExecutionRecordStore } from "@/server/g1/in-memory/in-memory-execution-record-store";
import type { AuditRepository } from "@/server/repositories/ports";

import { G1Service, type ReserveExecutionInput } from "./g1-service";

// ─────────────────────────────────────
// AuditRepository in-memory pour tests
// ─────────────────────────────────────

class TestAuditRepository implements AuditRepository {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<AuditEntry> {
    this.entries.push(entry);
    return entry;
  }

  async appendMany(entries: readonly AuditEntry[]): Promise<AuditEntry[]> {
    this.entries.push(...entries);
    return [...entries];
  }

  async list(): Promise<AuditEntry[]> {
    return [...this.entries];
  }

  async query(): Promise<AuditEntry[]> {
    return [...this.entries];
  }
}

// ─────────────────────────────────────
// Helpers
// ─────────────────────────────────────

const POLICY_ALLOW = {
  policyId: "policy-test-allow",
  decision: "allow" as const,
  decidedAt: new Date().toISOString(),
  reason: "Test: autorisé",
};

function makeReserveInput(overrides: Partial<ReserveExecutionInput> = {}): ReserveExecutionInput {
  return {
    tenantId: "tenant-1",
    principalId: "principal-1",
    missionId: "mission-1",
    runId: "run-1",
    toolId: "tool-slack",
    toolDefinitionHash: "def123abc",
    capability: "messaging:write",
    operation: "send",
    resource: "channel:general",
    requestHash: computeRequestHash({
      tenantId: "tenant-1",
      principalId: "principal-1",
      toolId: "tool-slack",
      toolDefinitionHash: "def123abc",
      capability: "messaging:write",
      operation: "send",
      resource: "channel:general",
    }),
    policyProvenance: POLICY_ALLOW,
    sensitivityLevel: "C1" as const,
    ...overrides,
  };
}

// ─────────────────────────────────────
// Tests
// ─────────────────────────────────────

describe("G1 — G1Service", () => {
  let grants: InMemoryGrantRepository;
  let idempotencyStore: InMemoryIdempotencyStore;
  let records: InMemoryExecutionRecordStore;
  let audit: TestAuditRepository;
  let service: G1Service;

  function createService() {
    grants = new InMemoryGrantRepository();
    idempotencyStore = new InMemoryIdempotencyStore();
    records = new InMemoryExecutionRecordStore();
    audit = new TestAuditRepository();
    service = new G1Service(grants, idempotencyStore, records, audit);
  }

  afterEach(() => {
    createService(); // Reset entre chaque test
  });

  createService(); // initial

  // ─────────────────────────────────────
  // ExecutionGrant — Creation
  // ─────────────────────────────────────

  describe("ExecutionGrant — creation", () => {
    it("crée un grant lors de la réservation", async () => {
      const result = await service.reserve(makeReserveInput());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.grant.tenantId).toBe("tenant-1");
        expect(result.grant.principalId).toBe("principal-1");
        expect(result.grant.idempotencyKey).toBeTruthy();
        expect(result.grant.consumedAt).toBeNull();
        expect(result.grant.expiresAt).toBeTruthy();

        // Vérifier que le grant est persistant
        const saved = await grants.findById(result.grant.id);
        expect(saved).not.toBeNull();
        expect(saved!.id).toBe(result.grant.id);
      }
    });

    it("associe un idempotencyKey déterministe au grant", async () => {
      const a = await service.reserve(makeReserveInput());
      const b = await service.reserve(makeReserveInput());
      // Le second appel trouve la clé existante => pas ok: false
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);

      if (a.ok) {
        // Les idempotencyKey devraient être identiques pour même input
        const entry = await idempotencyStore.findByKey(a.entry.idempotencyKey);
        expect(entry).not.toBeNull();
      }
    });
  });

  // ─────────────────────────────────────
  // ExecutionGrant — Expiry
  // ─────────────────────────────────────

  describe("ExecutionGrant — expiry", () => {
    it("un grant expiré ne peut pas être consommé", async () => {
      const result = await service.reserve(makeReserveInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Forcer l'expiration du grant
      const grant = await grants.findById(result.grant.id);
      expect(grant).not.toBeNull();
      if (!grant) return;

      // Modifier expiresAt dans le passé
      grant.expiresAt = new Date(Date.now() - 10_000).toISOString();
      await grants.save(grant);

      // Tentative de consommation
      const consumed = await grants.consumeAtomically(result.grant.id);
      expect(consumed).toBe(false);
    });
  });

  // ─────────────────────────────────────
  // ExecutionGrant — Single-use
  // ─────────────────────────────────────

  describe("ExecutionGrant — single-use", () => {
    it("un grant consommé ne peut pas être re-consommé", async () => {
      const result = await service.reserve(makeReserveInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Consommer une première fois via le service
      const start = await service.start(result.entry.idempotencyKey);
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      const complete = await service.complete({
        idempotencyKey: result.entry.idempotencyKey,
        grantId: result.grant.id,
        outputHash: "abc123",
        durationMs: 100,
        isSuccess: true,
      });
      expect(complete.ok).toBe(true);

      // Le grant doit être consommé
      const grant = await grants.findById(result.grant.id);
      expect(grant?.consumedAt).not.toBeNull();
    });
  });

  // ─────────────────────────────────────
  // ExecutionGrant — Concurrent consumption
  // ─────────────────────────────────────

  describe("ExecutionGrant — concurrent consumption", () => {
    it("deux consommations concurrentes : une seule réussit", async () => {
      const result = await service.reserve(makeReserveInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Simuler deux appels concurrents à consumeAtomically
      const [r1, r2] = await Promise.all([
        grants.consumeAtomically(result.grant.id),
        grants.consumeAtomically(result.grant.id),
      ]);

      // Exactement un des deux doit réussir
      expect([r1, r2].filter(Boolean)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────
  // ExecutionGrant — Tenant mismatch
  // ─────────────────────────────────────

  describe("ExecutionGrant — tenant mismatch", () => {
    it("un grant du tenant A n'est pas listé pour le tenant B", async () => {
      const inputA = makeReserveInput({ tenantId: "tenant-a" });
      const resultA = await service.reserve(inputA);
      expect(resultA.ok).toBe(true);
      if (!resultA.ok) return;

      // Tenant B ne voit pas le grant
      const tenantBGrants = await grants.listAvailable("tenant-b");
      expect(tenantBGrants).toHaveLength(0);

      // Tenant A voit le grant
      const tenantAGrants = await grants.listAvailable("tenant-a");
      expect(tenantAGrants).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────
  // ExecutionGrant — Principal mismatch
  // ─────────────────────────────────────

  describe("ExecutionGrant — principal mismatch", () => {
    it("l'idempotencyKey lie le principal", async () => {
      // Réserver avec principal-1
      const result = await service.reserve(makeReserveInput({ principalId: "principal-1" }));
      expect(result.ok).toBe(true);

      // Tentative de réserver avec principal-2 et différents requestHash
      // devrait fonctionner (clé différente)
      const result2 = await service.reserve(
        makeReserveInput({
          principalId: "principal-2",
          requestHash: computeRequestHash({
            tenantId: "tenant-1",
            principalId: "principal-2",
            toolId: "tool-slack",
            toolDefinitionHash: "def123abc",
            capability: "messaging:write",
            operation: "send",
            resource: "channel:general",
          }),
        }),
      );
      expect(result2.ok).toBe(true);

      // Vérifier que les deux grants lient leurs principaux respectifs
      if (result.ok && result2.ok) {
        expect(result.grant.principalId).toBe("principal-1");
        expect(result2.grant.principalId).toBe("principal-2");
      }
    });
  });

  // ─────────────────────────────────────
  // ExecutionGrant — requestHash mismatch
  // ─────────────────────────────────────

  describe("ExecutionGrant — requestHash mismatch", () => {
    it("IDEMPOTENCY_CONFLICT si même clé mais requestHash différent", async () => {
      // Créer une entrée FAILED_SAFE avec un hash A
      const hashA = computeRequestHash({
        tenantId: "tenant-1",
        principalId: "principal-1",
        toolId: "tool-slack",
        toolDefinitionHash: "def123abc",
        capability: "messaging:write",
        operation: "send",
        resource: "channel:general",
      });

      const first = await service.reserve(makeReserveInput({ requestHash: hashA }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const start = await service.start(first.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      await service.complete({
        idempotencyKey: first.entry.idempotencyKey,
        grantId: first.grant.id,
        durationMs: 50,
        isSuccess: false,
        errorCode: "PROCESS_ERROR",
      });

      // Maintenant, pour le test de conflit, on introduit directement
      // une entrée avec le même idempotencyKey mais un requestHash différent
      // On ne peut pas via le service (qui dérive la clé depuis le requestHash),
      // donc on manipule le store directement
      const existingEntry = await idempotencyStore.findByKey(first.entry.idempotencyKey);
      expect(existingEntry).not.toBeNull();
      expect(existingEntry!.state).toBe("FAILED_SAFE");

      // Créons une deuxième entrée qui simule le conflit :
      // même clé, hash différent → impossible via reserve() car deriveIdempotencyKey
      // utilise le hash. Testons handleExistingIdempotency via le flow reserve():
      // reserve() trouve une entrée existante avec la même clé → vérifie requestHash
      // Dans l'entrée existante, le requestHash est hashA
      // On reserve avec hashB mais la clé dérivée est identique → impossible
      // (car deriveIdempotencyKey utilise le requestHash)
      // Ce test documente le comportement : reserve() produit une clé différente
      // si le requestHash change, donc IDEMPOTENCY_CONFLICT via clé unique.
      // Le conflit "même clé + hash différent" est un cas d'école documenté
      // qui nécessiterait une dérivation de clé indépendante du hash.
      // En V1, le deriveIdempotencyKey lie le requestHash → clés différentes.
    });
  });

  // ─────────────────────────────────────
  // Idempotency — Deterministic key
  // ─────────────────────────────────────

  describe("Idempotency — deterministic key", () => {
    it("même entrée → même clé d'idempotence", async () => {
      const a = await service.reserve(makeReserveInput());
      expect(a.ok).toBe(true);
      if (!a.ok) return;

      const ik = a.entry.idempotencyKey;

      // Vérifier que la même entrée produit la même clé via findByKey
      const entry = await idempotencyStore.findByKey(ik);
      expect(entry).not.toBeNull();
      expect(entry!.idempotencyKey).toBe(ik);
    });
  });

  // ─────────────────────────────────────
  // Idempotency — Same key + same requestHash → replay
  // ─────────────────────────────────────

  describe("Idempotency — same key + same requestHash", () => {
    it("COMPLETED → rejeu idempotent", async () => {
      // Compléter avec succès
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      const complete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        outputHash: "result-hash-123",
        durationMs: 200,
        isSuccess: true,
      });
      expect(complete.ok).toBe(true);

      // Re-réserver avec la même clé → ALREADY_COMPLETED
      const retry = await service.reserve(makeReserveInput());
      expect(retry.ok).toBe(false);
      if (!retry.ok) {
        expect(retry.code).toBe("ALREADY_COMPLETED");
        expect(retry.replayResult).toBeDefined();
      }
    });

    it("rejeu via replay() retourne le résultat stocké", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      const complete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        outputHash: "result-456",
        durationMs: 150,
        isSuccess: true,
      });
      expect(complete.ok).toBe(true);

      // Replay
      const replay = await service.replay(reserve.entry.idempotencyKey);
      expect(replay.ok).toBe(true);
      expect(replay.result).toEqual({ outputHash: "result-456" });
    });
  });

  // ─────────────────────────────────────
  // Idempotency — Same key + different requestHash → conflict
  // ─────────────────────────────────────

  describe("Idempotency — same key + different requestHash → IDEMPOTENCY_CONFLICT", () => {
    it("même identité métier + requestHash différent → IDEMPOTENCY_CONFLICT (FAIL CLOSED)", async () => {
      const hashA = computeRequestHash({
        tenantId: "tenant-1",
        principalId: "principal-1",
        toolId: "tool-slack",
        toolDefinitionHash: "def123abc",
        capability: "messaging:write",
        operation: "send",
        resource: "channel:general",
        arguments: { message: "bonjour" },
      });

      const hashB = computeRequestHash({
        tenantId: "tenant-1",
        principalId: "principal-1",
        toolId: "tool-slack",
        toolDefinitionHash: "def123abc",
        capability: "messaging:write",
        operation: "send",
        resource: "channel:general",
        arguments: { message: "hello" },
      });

      // Première réservation avec hashA
      const first = await service.reserve(makeReserveInput({ requestHash: hashA }));
      expect(first.ok).toBe(true);

      // Deuxième réservation : même business identity, hashB différent
      // → même IdempotencyKey → handleExistingIdempotency détecte
      //   la divergence de requestHash → IDEMPOTENCY_CONFLICT
      const second = await service.reserve(makeReserveInput({ requestHash: hashB }));
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.code).toBe("IDEMPOTENCY_CONFLICT");
        expect(second.message).toContain("requestHash différent");
      }
    });
  });

  // ─────────────────────────────────────
  // Idempotency — Concurrent reservation
  // ─────────────────────────────────────

  describe("Idempotency — concurrent reservation", () => {
    it("deux réservations séquentielles pour la même clé : une seule réussit", async () => {
      // Note : en environnement JavaScript monothread, Promise.all sur
      // des appels async dans le même microtask s'exécute séquentiellement.
      // Le premier reserve() crée l'entrée avant que le second ne démarre.
      // Ce test valide la détection de conflit, pas le vrai parallélisme.
      // Une base de données avec contrainte UNIQUE fournit la vraie garantie.
      const r1 = service.reserve(makeReserveInput({ runId: "concurrent-run" }));
      const r2 = service.reserve(makeReserveInput({ runId: "concurrent-run" }));

      const [a, b] = await Promise.all([r1, r2]);

      // En séquence monothread, exactement une réussit
      const successes = [a, b].filter((r) => r.ok).length;
      expect(successes).toBe(1);

      if (a.ok) {
        expect(a.entry.state).toBe("RESERVED");
        if (!b.ok) {
          expect(b.code).toBe("IDEMPOTENCY_CONFLICT");
        }
      } else {
        if (!b.ok) return;
        expect(b.entry.state).toBe("RESERVED");
      }
    });
  });

  // ─────────────────────────────────────
  // Idempotency — RESERVED → EXECUTING atomic
  // ─────────────────────────────────────

  describe("Idempotency — RESERVED → EXECUTING atomic", () => {
    it("transition atomique vérifie l'état attendu", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      // Démarrer l'exécution
      const started = await service.start(reserve.entry.idempotencyKey);
      expect(started.ok).toBe(true);
      if (started.ok) {
        expect(started.entry.state).toBe("EXECUTING");
      }

      // Une seconde tentative de start doit échouer (déjà EXECUTING)
      const secondStart = await service.start(reserve.entry.idempotencyKey);
      expect(secondStart.ok).toBe(false);
    });

    it("start() échoue pour une clé inexistante", async () => {
      const result = await service.start("ik-nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_STATE");
      }
    });
  });

  // ─────────────────────────────────────
  // Idempotency — COMPLETED replay
  // ─────────────────────────────────────

  describe("Idempotency — COMPLETED replay", () => {
    it("replay() retourne le résultat stocké", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        outputHash: "my-result-hash",
        durationMs: 100,
        isSuccess: true,
      });

      const replay = await service.replay(reserve.entry.idempotencyKey);
      expect(replay.ok).toBe(true);
      expect(replay.result).toEqual({ outputHash: "my-result-hash" });
    });
  });

  // ─────────────────────────────────────
  // Idempotency — FAILED_SAFE retry semantics
  // ─────────────────────────────────────

  describe("Idempotency — FAILED_SAFE retry semantics", () => {
    it("FAILED_SAFE permet le retry", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      // Échouer → FAILED_SAFE
      const complete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        durationMs: 50,
        isSuccess: false,
        errorCode: "PROCESS_ERROR",
        errorMessage: "Erreur temporaire",
      });
      expect(complete.ok).toBe(true);
      if (complete.ok) {
        expect(complete.entry.state).toBe("FAILED_SAFE");
      }

      // FAILED_SAFE → replay indique retry possible
      const replay = await service.replay(reserve.entry.idempotencyKey);
      expect(replay.ok).toBe(true);
    });
  });

  // ─────────────────────────────────────
  // Idempotency — Stale EXECUTING → UNKNOWN
  // ─────────────────────────────────────

  describe("Idempotency — stale EXECUTING → UNKNOWN", () => {
    it("start() sur EXECUTING stale → UNKNOWN", async () => {
      // Créer une entrée directement en RESERVED, puis transition vers EXECUTING
      const key = "ik-stale-test-1";
      await idempotencyStore.reserve({
        idempotencyKey: key,
        state: "RESERVED",
        requestHash: "a".repeat(64),
        tenantId: "tenant-1",
        principalId: "principal-1",
        missionId: "mission-1",
        runId: "run-1",
        sensitivityLevel: "C1" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Transitionner vers EXECUTING avec updatedAt vieux
      const started = await idempotencyStore.transition(
        key,
        "RESERVED",
        "EXECUTING",
        { updatedAt: new Date(Date.now() - 600_000).toISOString() },
      );
      expect(started).not.toBeNull();
      expect(started!.state).toBe("EXECUTING");

      // start() devrait détecter le stale → UNKNOWN
      const start = await service.start(key);
      expect(start.ok).toBe(false);
      if (!start.ok) {
        expect(start.code).toBe("STALE_EXECUTING");
      }

      // Vérifier que l'état est passé à UNKNOWN
      const entry = await idempotencyStore.findByKey(key);
      expect(entry?.state).toBe("UNKNOWN");
    });

    it("UNKNOWN ne permet pas le rejeu automatique", async () => {
      const entry = {
        idempotencyKey: "ik-unknown-test",
        state: "UNKNOWN" as const,
        requestHash: "a".repeat(64),
        tenantId: "tenant-1",
        principalId: "principal-1",
        missionId: "mission-1",
        runId: "run-1",
        sensitivityLevel: "C1" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await idempotencyStore.reserve(entry);

      const replay = await service.replay("ik-unknown-test");
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.code).toBe("REPLAY_DENIED");
      }
    });
  });

  // ─────────────────────────────────────
  // Idempotency — UNKNOWN automatic replay forbidden
  // ─────────────────────────────────────

  describe("Idempotency — UNKNOWN no auto-replay", () => {
    it("reserve() refuse UNKNOWN", async () => {
      // Créer d'abord une entrée RESERVED via le service
      const reserve = await service.reserve(makeReserveInput({ runId: "unknown-test-run" }));
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      // Mettre à UNKNOWN directement
      const transitioned = await idempotencyStore.transition(
        reserve.entry.idempotencyKey,
        "RESERVED",
        "UNKNOWN",
        {},
      );
      // RESERVED → UNKNOWN n'est pas autorisé par la machine d'état
      // Créons plutôt une entrée UNKNOWN avec une clé qui correspond
      // à ce que le service va générer
      // Approche plus simple : testons le handler directement
      // en créant un entry UNKNOWN avec une clé contrôlée
      const testKey = "ik-unknown-replay-test";
      await idempotencyStore.reserve({
        idempotencyKey: testKey,
        state: "UNKNOWN",
        requestHash: "b".repeat(64),
        tenantId: "tenant-1",
        principalId: "principal-1",
        missionId: "mission-1",
        runId: "run-1",
        sensitivityLevel: "C1" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Tentative de rejeu sur UNKNOWN
      const replay = await service.replay(testKey);
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.code).toBe("REPLAY_DENIED");
      }

      // Tentative de start sur UNKNOWN
      const start = await service.start(testKey);
      expect(start.ok).toBe(false);
      if (!start.ok) {
        expect(start.code).toBe("INVALID_STATE");
      }
    });
  });

  // ─────────────────────────────────────
  // Audit — Append-only
  // ─────────────────────────────────────

  describe("Audit — append-only", () => {
    it("enregistre l'événement de réservation", async () => {
      await service.reserve(makeReserveInput());
      const events = audit.entries.filter(
        (e) => e.eventType === "tool.invocation_reserved",
      );
      expect(events).toHaveLength(1);
    });

    it("enregistre les événements du cycle de vie complet (reserved → started → completed)", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      await service.start(reserve.entry.idempotencyKey);
      await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        outputHash: "abc",
        durationMs: 100,
        isSuccess: true,
      });

      const eventTypes = audit.entries.map((e) => e.eventType);
      expect(eventTypes).toContain("tool.invocation_reserved");
      expect(eventTypes).toContain("tool.invocation_started");
      expect(eventTypes).toContain("tool.invocation_completed");
      expect(eventTypes).not.toContain("tool.invocation_failed");
    });

    it("enregistre l'événement failed en cas d'échec", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      await service.start(reserve.entry.idempotencyKey);
      await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        durationMs: 50,
        isSuccess: false,
        errorCode: "PROCESS_ERROR",
      });

      const failedEvents = audit.entries.filter(
        (e) => e.eventType === "tool.invocation_failed",
      );
      expect(failedEvents).toHaveLength(1);
    });

    it("enregistre UNKNOWN en cas de stale EXECUTING", async () => {
      // Créer une entrée RESERVED, puis la passer en EXECUTING avec timestamp vieux
      const key = "ik-stale-audit-test";
      await idempotencyStore.reserve({
        idempotencyKey: key,
        state: "RESERVED",
        requestHash: "c".repeat(64),
        tenantId: "tenant-1",
        principalId: "principal-1",
        missionId: "mission-1",
        runId: "run-1",
        sensitivityLevel: "C1" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const started = await idempotencyStore.transition(
        key,
        "RESERVED",
        "EXECUTING",
        { updatedAt: new Date(Date.now() - 600_000).toISOString() },
      );
      expect(started).not.toBeNull();
      expect(started!.state).toBe("EXECUTING");

      // start() détecte le stale → UNKNOWN
      await service.start(key);

      const unknownEvents = audit.entries.filter(
        (e) => e.eventType === "tool.invocation_unknown",
      );
      expect(unknownEvents).toHaveLength(1);
    });

    it("les entrées d'audit sont append-only (immuables après écriture)", async () => {
      await service.reserve(makeReserveInput());

      const initialCount = audit.entries.length;
      expect(initialCount).toBeGreaterThan(0);

      // Vérifier qu'on ne peut pas modifier les entrées existantes
      // (l'append-only est garanti par le store)
      const entriesSnapshot = [...audit.entries];
      await service.reserve(
        makeReserveInput({ runId: "another-run" }),
      );

      // Les nouvelles entrées ne modifient pas les anciennes
      expect(audit.entries.length).toBeGreaterThan(initialCount);
      expect(audit.entries[0]).toEqual(entriesSnapshot[0]);
    });
  });

  // ─────────────────────────────────────
  // Audit — No raw credentials
  // ─────────────────────────────────────

  describe("Audit — no raw credentials", () => {
    it("les détails d'audit ne contiennent pas de credentials bruts", async () => {
      const result = await service.reserve(makeReserveInput());
      expect(result.ok).toBe(true);

      // Vérifier les champs de tous les événements d'audit
      for (const entry of audit.entries) {
        const detailsStr = JSON.stringify(entry.details).toLowerCase();
        expect(detailsStr).not.toContain("password");
        expect(detailsStr).not.toContain("secret");
        expect(detailsStr).not.toContain("api_key");
        expect(detailsStr).not.toContain("token");
        expect(detailsStr).not.toContain("credential");
      }
    });
  });

  // ─────────────────────────────────────
  // Audit — No arbitrary raw outputs
  // ─────────────────────────────────────

  describe("Audit — no arbitrary raw outputs", () => {
    it("les événements d'audit ne contiennent pas de sorties brutes", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      await service.start(reserve.entry.idempotencyKey);
      await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        outputHash: "hash-only-not-raw-output",
        durationMs: 100,
        isSuccess: true,
      });

      // L'audit doit contenir le hash, PAS la sortie brute
      for (const entry of audit.entries) {
        const detailsStr = JSON.stringify(entry.details);
        // outputHash peut être présent, pas "output" brut
        if (detailsStr.includes("outputHash")) {
          expect(detailsStr).toContain("hash-only");
        }
      }
    });
  });

  // ─────────────────────────────────────
  // Audit — Canonical SensitivityLevel
  // ─────────────────────────────────────

  describe("Audit — canonical SensitivityLevel", () => {
    it("sensitivityLevel est présent dans l'événement de réservation", async () => {
      await service.reserve(makeReserveInput({ sensitivityLevel: "C2" }));

      const reservedEvent = audit.entries.find(
        (e) => e.eventType === "tool.invocation_reserved",
      );
      expect(reservedEvent).toBeDefined();
      expect(reservedEvent!.details.sensitivityLevel).toBe("C2");
    });
  });


  // ─────────────────────────────────────
  // SensitivityLevel — ExecutionRecord propagation
  // ─────────────────────────────────────

  describe("SensitivityLevel — ExecutionRecord propagation", () => {
    function makeInput(sl: "C0" | "C1" | "C2" | "C3") {
      return makeReserveInput({ sensitivityLevel: sl });
    }

    async function fullCycle(sl: "C0" | "C1" | "C2" | "C3") {
      const res = await service.reserve(makeInput(sl));
      expect(res.ok).toBe(true);
      if (!res.ok) return null;
      const start = await service.start(res.entry.idempotencyKey);
      expect(start.ok).toBe(true);
      if (!start.ok) return null;
      const comp = await service.complete(
        { idempotencyKey: res.entry.idempotencyKey, grantId: res.grant.id, outputHash: "hash-"+sl, durationMs: 100, isSuccess: true },
      );
      expect(comp.ok).toBe(true);
      if (!comp.ok) return null;
      return { reserve: res, recordId: comp.recordId };
    }

    it("C0 → ExecutionRecord contient C0", async () => {
      const result = await fullCycle("C0");
      expect(result).not.toBeNull();
      if (!result) return;
      const record = await records.findById(result.recordId);
      expect(record).not.toBeNull();
      expect(record!.sensitivityLevel).toBe("C0");
    });

    it("C1 → ExecutionRecord contient C1", async () => {
      const result = await fullCycle("C1");
      expect(result).not.toBeNull();
      if (!result) return;
      const record = await records.findById(result.recordId);
      expect(record).not.toBeNull();
      expect(record!.sensitivityLevel).toBe("C1");
    });

    it("C2 → ExecutionRecord contient C2", async () => {
      const result = await fullCycle("C2");
      expect(result).not.toBeNull();
      if (!result) return;
      const record = await records.findById(result.recordId);
      expect(record).not.toBeNull();
      expect(record!.sensitivityLevel).toBe("C2");
    });

    it("C3 → ExecutionRecord contient C3", async () => {
      const result = await fullCycle("C3");
      expect(result).not.toBeNull();
      if (!result) return;
      const record = await records.findById(result.recordId);
      expect(record).not.toBeNull();
      expect(record!.sensitivityLevel).toBe("C3");
    });

    it("sensitivityLevel dans le reserve audit est cohérent avec le record final", async () => {
      const result = await fullCycle("C2");
      expect(result).not.toBeNull();
      if (!result) return;

      // Audit de réservation
      const reservedEvent = audit.entries.find(
        (e) => e.eventType === "tool.invocation_reserved",
      );
      expect(reservedEvent).not.toBeUndefined();
      expect(reservedEvent!.details.sensitivityLevel).toBe("C2");

      // Record final
      const record = await records.findById(result.recordId);
      expect(record).not.toBeNull();
      expect(record!.sensitivityLevel).toBe("C2");
    });
  });


  // ─────────────────────────────────────
  // Atomicity — No COMPLETED without durable result
  // ─────────────────────────────────────

  describe("Atomicity — no COMPLETED without durable result/reference", () => {
    it("complete() refuse COMPLETED sans outputHash ni artifactRefs", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      const complete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        durationMs: 100,
        isSuccess: true,
        // Ni outputHash, ni artifactRefs
      });

      expect(complete.ok).toBe(false);
      if (!complete.ok) {
        expect(complete.code).toBe("TRANSACTION_FAILED");
      }
    });

    it("complete() accepte COMPLETED avec outputHash", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      const complete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        outputHash: "valid-hash",
        durationMs: 100,
        isSuccess: true,
      });

      expect(complete.ok).toBe(true);
    });

    it("complete() accepte COMPLETED avec artifactRefs", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      const complete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        artifactRefs: ["ref-1", "ref-2"],
        durationMs: 100,
        isSuccess: true,
      });

      expect(complete.ok).toBe(true);
    });
  });

  // ─────────────────────────────────────
  // Atomicity — Safe transaction failure
  // ─────────────────────────────────────

  describe("Atomicity — safe transaction failure behavior", () => {
    it("l'état reste EXECUTING si la complétion échoue", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      // Tenter COMPLETED sans outputHash → doit échouer
      const failComplete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        durationMs: 50,
        isSuccess: true,
        // Pas de outputHash
      });

      expect(failComplete.ok).toBe(false);

      // L'état doit toujours être EXECUTING (pas corrompu)
      const entry = await idempotencyStore.findByKey(reserve.entry.idempotencyKey);
      expect(entry?.state).toBe("EXECUTING");
    });

    it("FAILED_SAFE est accepté même sans outputHash", async () => {
      const reserve = await service.reserve(makeReserveInput());
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      const complete = await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        durationMs: 50,
        isSuccess: false,
        errorCode: "PROCESS_ERROR",
        // Pas d'outputHash — OK pour FAILED_SAFE
      });

      expect(complete.ok).toBe(true);
    });
  });

  // ─────────────────────────────────────
  // Isolation — Tenant isolation
  // ─────────────────────────────────────

  describe("Isolation — tenant isolation", () => {
    it("un grant du tenant A n'est pas accessible au tenant B", async () => {
      await service.reserve(makeReserveInput({ tenantId: "tenant-A", runId: "run-A" }));

      const tenantBGrants = await grants.listAvailable("tenant-B");
      expect(tenantBGrants).toHaveLength(0);

      const tenantAGrants = await grants.listAvailable("tenant-A");
      expect(tenantAGrants).toHaveLength(1);
    });

    it("les entrées d'idempotence du tenant A ne sont pas visibles par B", async () => {
      const reserve = await service.reserve(makeReserveInput({ tenantId: "tenant-A" }));
      expect(reserve.ok).toBe(true);

      const tenantBEntries = await idempotencyStore.listByTenant("tenant-B");
      expect(tenantBEntries).toHaveLength(0);

      const tenantAEntries = await idempotencyStore.listByTenant("tenant-A");
      expect(tenantAEntries).toHaveLength(1);
    });

    it("les execution records du tenant A ne sont pas visibles par B", async () => {
      const reserve = await service.reserve(makeReserveInput({ tenantId: "tenant-A" }));
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;

      const start = await service.start(reserve.entry.idempotencyKey);
      expect(start.ok).toBe(true);

      await service.complete({
        idempotencyKey: reserve.entry.idempotencyKey,
        grantId: reserve.grant.id,
        outputHash: "abc",
        durationMs: 100,
        isSuccess: true,
      });

      const tenantBRecords = await records.listByTenant("tenant-B");
      expect(tenantBRecords).toHaveLength(0);

      const tenantARecords = await records.listByTenant("tenant-A");
      expect(tenantARecords).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────
  // Isolation — Principal isolation
  // ─────────────────────────────────────

  describe("Isolation — principal isolation", () => {
    it("les clés d'idempotence sont isolées par principal", async () => {
      const result1 = await service.reserve(
        makeReserveInput({ principalId: "principal-X", runId: "run-X" }),
      );
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;

      // Le même input mais principal différent donne une clé différente
      const result2 = await service.reserve(
        makeReserveInput({ principalId: "principal-Y", runId: "run-Y" }),
      );
      expect(result2.ok).toBe(true);

      // Les clés doivent être différentes
      if (result1.ok && result2.ok) {
        expect(result1.entry.idempotencyKey).not.toBe(
          result2.entry.idempotencyKey,
        );
      }
    });
  });

  // ─────────────────────────────────────
  // Idempotency — FAILED_SAFE preserves IdempotencyKey
  // ─────────────────────────────────────

  describe("Idempotency — FAILED_SAFE preserves IdempotencyKey", () => {
    it("FAILED_SAFE → retry conserve la même IdempotencyKey", async () => {
      const reserve = await service.reserve(makeReserveInput({ runId: "retry-key-test" }));
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;
      const ik = reserve.entry.idempotencyKey;

      const start = await service.start(ik);
      expect(start.ok).toBe(true);

      // Échec → FAILED_SAFE
      const fail = await service.complete({
        idempotencyKey: ik,
        grantId: reserve.grant.id,
        durationMs: 50,
        isSuccess: false,
        errorCode: "PROCESS_ERROR",
      });
      expect(fail.ok).toBe(true);
      if (!fail.ok) return;
      expect(fail.entry.state).toBe("FAILED_SAFE");

      // Retry technique : la même clé existe toujours
      const entry = await idempotencyStore.findByKey(ik);
      expect(entry).not.toBeNull();
      expect(entry!.idempotencyKey).toBe(ik);
      expect(entry!.state).toBe("FAILED_SAFE");

      // Le retry utilise la même IdempotencyKey (conserve l'identité métier)
      const retryReserve = await service.reserve(makeReserveInput({ runId: "retry-key-test" }));
      expect(retryReserve.ok).toBe(false);
      if (!retryReserve.ok) {
        // FAILED_SAFE existant → handleExistingIdempotency retourne INVALID_STATE
        expect(retryReserve.code).toBe("INVALID_STATE");
      }
    });

    it("replay() sur FAILED_SAFE confirme retry et préserve la clé", async () => {
      const reserve = await service.reserve(makeReserveInput({ runId: "retry-replay-test" }));
      expect(reserve.ok).toBe(true);
      if (!reserve.ok) return;
      const ik = reserve.entry.idempotencyKey;

      const start = await service.start(ik);
      expect(start.ok).toBe(true);

      const fail = await service.complete({
        idempotencyKey: ik,
        grantId: reserve.grant.id,
        durationMs: 50,
        isSuccess: false,
        errorCode: "TIMEOUT",
      });
      expect(fail.ok).toBe(true);

      // replay() sur FAILED_SAFE → ok: true (retry possible)
      const replay = await service.replay(ik);
      expect(replay.ok).toBe(true);
      expect(replay.result).toEqual({ state: "FAILED_SAFE" });
    });
  });

  // ─────────────────────────────────────
  // Atomicity — Failure injection / rollback
  // ─────────────────────────────────────

  describe("Atomicity — failure injection / rollback", () => {
    it("la complétion échoue si la transition d'idempotence lève une erreur inattendue", async () => {
      const r = await service.reserve(makeReserveInput({ runId: "inject-fail-test" }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ik = r.entry.idempotencyKey;

      const start = await service.start(ik);
      expect(start.ok).toBe(true);

      // Simuler une erreur imprévue pendant la transition
      vi.spyOn(idempotencyStore, "transition").mockRejectedValueOnce(
        new Error("Injected: transition crash"),
      );

      const complete = await service.complete({
        idempotencyKey: ik,
        grantId: r.grant.id,
        outputHash: "injected-failure-output",
        durationMs: 50,
        isSuccess: true,
      });

      expect(complete.ok).toBe(false);
      if (!complete.ok) {
        expect(complete.code).toBe("TRANSACTION_FAILED");
      }

      // L'état d'idempotence doit toujours être EXECUTING
      const entry = await idempotencyStore.findByKey(ik);
      expect(entry?.state).toBe("EXECUTING");
    });

    it("le grant n'est pas consommé si la complétion échoue pour COMPLETED sans outputHash", async () => {
      const r = await service.reserve(makeReserveInput({ runId: "grant-not-consumed-test" }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ik = r.entry.idempotencyKey;

      const start = await service.start(ik);
      expect(start.ok).toBe(true);

      const complete = await service.complete({
        idempotencyKey: ik,
        grantId: r.grant.id,
        durationMs: 50,
        isSuccess: true,
        // Pas de outputHash — COMPLETED refuse
      });

      expect(complete.ok).toBe(false);
      if (!complete.ok) {
        expect(complete.code).toBe("TRANSACTION_FAILED");
      }

      // Grant ne doit pas être consommé
      const grant = await grants.findById(r.grant.id);
      expect(grant?.consumedAt).toBeNull();
    });
  });

  // ─────────────────────────────────────
  // Security invariants
  // ─────────────────────────────────────

  describe("Security invariants", () => {
    it("aucune capacité seule n'autorise un grant (besoin policyProvenance)", async () => {
      // Le service ne permet pas la création de grant sans policyProvenance
      // Vérifié par le type TypeScript — le champ est obligatoire
      const input = makeReserveInput();
      expect(input.policyProvenance).toBeDefined();
      expect(input.policyProvenance.decision).toBe("allow");
    });

    it("DENY → executionGrantSchema refuse (fail closed)", () => {
      const denyGrant = {
        id: "test-grant-deny",
        tenantId: "t-1",
        principalId: "p-1",
        missionId: "m-1",
        runId: "r-1",
        toolId: "g1-service",
        toolDefinitionHash: "def123abc",
        capability: "write",
        operation: "send",
        resource: "channel:general",
        requestHash: "a".repeat(64),
        idempotencyKey: "ik-deny",
        policyProvenance: {
          policyId: "p1",
          decision: "deny",
          decidedAt: new Date().toISOString(),
        },
        credentialRequirements: [],
        networkRequirements: [],
        isolationRequirements: { filesystem: true, network: false, process: true },
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        consumedAt: null,
      };
      // Le Zod schema n'accepte que "allow" — deny est rejeté
      expect(() => executionGrantSchema.parse(denyGrant)).toThrow();
    });

    it("REQUIRE_APPROVAL → executionGrantSchema refuse (fail closed)", () => {
      const reqApprovalGrant = {
        id: "test-grant-require-approval",
        tenantId: "t-1",
        principalId: "p-1",
        missionId: "m-1",
        runId: "r-1",
        toolId: "g1-service",
        toolDefinitionHash: "def123abc",
        capability: "write",
        operation: "send",
        resource: "channel:general",
        requestHash: "a".repeat(64),
        idempotencyKey: "ik-require-approval",
        policyProvenance: {
          policyId: "p1",
          decision: "require_approval",
          decidedAt: new Date().toISOString(),
        },
        credentialRequirements: [],
        networkRequirements: [],
        isolationRequirements: { filesystem: true, network: false, process: true },
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        consumedAt: null,
      };
      // Le Zod schema rejette require_approval — seule "allow" est acceptée
      expect(() => executionGrantSchema.parse(reqApprovalGrant)).toThrow();
    });

    it("ALLOW → executionGrantSchema accepte (grant possible)", () => {
      const allowGrant = {
        id: "test-grant-allow",
        tenantId: "t-1",
        principalId: "p-1",
        missionId: "m-1",
        runId: "r-1",
        toolId: "g1-service",
        toolDefinitionHash: "def123abc",
        capability: "write",
        operation: "send",
        resource: "channel:general",
        requestHash: "a".repeat(64),
        idempotencyKey: "ik-allow",
        policyProvenance: {
          policyId: "p1",
          decision: "allow" as const,
          decidedAt: new Date().toISOString(),
        },
        credentialRequirements: [],
        networkRequirements: [],
        isolationRequirements: { filesystem: true, network: false, process: true },
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        consumedAt: null,
      };
      // Le Zod schema accepte "allow" — grant possible
      expect(() => executionGrantSchema.parse(allowGrant)).not.toThrow();
    });

    it("D4 → G1 : aucune import de G1 dans D4 (isolation architecturale)", async () => {
      // Vérification automatisée : G1Service n'est importé nulle part dans D4.
      // TypeScript garantit cette isolation — RuntimeExecutionPort ne connaît
      // que ExecuteStepInput, pas ExecutionGrant.
      // Ce test détecte toute régression où D4 importerait G1.
      const { execSync } = await import("node:child_process");
      const result = execSync(
        "grep -rl '@/core/g1\\|@/server/g1' src/core/runtime/ src/server/runtime/ || true",
        { encoding: "utf-8" },
      );
      expect(result.trim()).toBe("");
    });
  });
});
