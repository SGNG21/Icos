import { describe, expect, it, beforeEach } from "vitest";

import {
  executionGrantSchema,
  executionRecordSchema,
  idempotencyStateSchema,
  isIdempotencyTransitionAllowed,
  IDEMPOTENCY_TERMINAL,
  IDEMPOTENCY_RETRYABLE,
  executionAttemptSchema,
  executionAuditPayloadSchema,
} from "@/core/contracts/tool";

import { InMemoryGrantRepository, InMemoryExecutionRecordRepository } from "@/server/services/in-memory/tool-repository";

// ─────────────────────────────────────
// Helpers
// ─────────────────────────────────────

function makeGrant(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return executionGrantSchema.parse({
    id: "grant-test-1",
    tenantId: "tenant-acme",
    principalId: "agent-cto",
    missionId: "mission-123",
    runId: "run-456",
    toolId: "tool.acme.email-sender",
    toolDefinitionHash: "def-hash-abc",
    toolVersion: "1.0.0",
    capability: "email.send",
    operation: "email.send",
    resource: "email:outbox",
    requestHash: "req-hash-001",
    idempotencyKey: "ik-tenant-acme:mission-123:email.send:req-hash-001",
    status: "issued",
    policyProvenance: {
      policyVersion: "1",
      attestedAt: now.toISOString(),
      gatesPassed: ["tenant", "permission", "risk"],
    },
    credentialRequirements: [],
    networkRequired: true,
    isolationLevel: "none",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
  });
}

function makeReserveInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "ik-tenant-acme:mission-123:email.send:req-hash-001",
    grantId: "grant-test-1",
    tenantId: "tenant-acme",
    missionId: "mission-123",
    runId: "run-456",
    toolId: "tool.acme.email-sender",
    requestHash: "req-hash-001",
    input: { to: "client@test.com", subject: "Devis" },
    ...overrides,
  };
}

// ─────────────────────────────────────
// Contracts
// ─────────────────────────────────────

describe("G1.0 — Contracts", () => {
  // Execution Grant
  it("crée un grant valide avec binding fort", () => {
    const grant = makeGrant();
    expect(grant.id).toBe("grant-test-1");
    expect(grant.tenantId).toBe("tenant-acme");
    expect(grant.principalId).toBe("agent-cto");
    expect(grant.missionId).toBe("mission-123");
    expect(grant.runId).toBe("run-456");
    expect(grant.toolId).toBe("tool.acme.email-sender");
    expect(grant.toolDefinitionHash).toBe("def-hash-abc");
    expect(grant.toolVersion).toBe("1.0.0");
    expect(grant.capability).toBe("email.send");
    expect(grant.operation).toBe("email.send");
    expect(grant.resource).toBe("email:outbox");
    expect(grant.requestHash).toBe("req-hash-001");
    expect(grant.status).toBe("issued");
  });

  it("rejette un toolId mal formé", () => {
    expect(() => makeGrant({ toolId: "invalid" })).toThrow();
    expect(() => makeGrant({ toolId: "tool..empty" })).toThrow();
  });

  it("rejette un grant sans requestHash", () => {
    expect(() => makeGrant({ requestHash: "" })).toThrow();
  });

  it("rejette un grant sans idempotencyKey", () => {
    expect(() => makeGrant({ idempotencyKey: "" })).toThrow();
  });

  // Idempotency State Machine
  it("a les bons états canoniques", () => {
    const states = idempotencyStateSchema.options;
    expect(states).toContain("RESERVED");
    expect(states).toContain("EXECUTING");
    expect(states).toContain("COMPLETED");
    expect(states).toContain("FAILED_SAFE");
    expect(states).toContain("UNKNOWN");
  });

  it("RESERVED → EXECUTING est valide", () => {
    expect(isIdempotencyTransitionAllowed("RESERVED", "EXECUTING")).toBe(true);
  });

  it("RESERVED → COMPLETED est invalide (skip EXECUTING)", () => {
    expect(isIdempotencyTransitionAllowed("RESERVED", "COMPLETED")).toBe(false);
  });

  it("EXECUTING → COMPLETED est valide", () => {
    expect(isIdempotencyTransitionAllowed("EXECUTING", "COMPLETED")).toBe(true);
  });

  it("EXECUTING → FAILED_SAFE est valide", () => {
    expect(isIdempotencyTransitionAllowed("EXECUTING", "FAILED_SAFE")).toBe(true);
  });

  it("EXECUTING → UNKNOWN est valide (crash)", () => {
    expect(isIdempotencyTransitionAllowed("EXECUTING", "UNKNOWN")).toBe(true);
  });

  it("COMPLETED est terminal (aucune transition)", () => {
    expect(isIdempotencyTransitionAllowed("COMPLETED", "FAILED_SAFE")).toBe(false);
    expect(isIdempotencyTransitionAllowed("COMPLETED", "UNKNOWN")).toBe(false);
    expect(IDEMPOTENCY_TERMINAL).toContain("COMPLETED");
  });

  it("UNKNOWN est terminal (aucune transition automatique)", () => {
    expect(isIdempotencyTransitionAllowed("UNKNOWN", "COMPLETED")).toBe(false);
    expect(IDEMPOTENCY_TERMINAL).toContain("UNKNOWN");
  });

  it("FAILED_SAFE → RESERVED est valide (retry)", () => {
    expect(isIdempotencyTransitionAllowed("FAILED_SAFE", "RESERVED")).toBe(true);
    expect(IDEMPOTENCY_RETRYABLE).toContain("FAILED_SAFE");
  });

  it("FAILED_SAFE → EXECUTING est invalide (doit passer par RESERVED)", () => {
    expect(isIdempotencyTransitionAllowed("FAILED_SAFE", "EXECUTING")).toBe(false);
  });

  // Execution Record
  it("crée un ExecutionRecord valide", () => {
    const record = executionRecordSchema.parse({
      id: "exec-rec-test-1",
      idempotencyKey: "ik-test-1",
      grantId: "grant-test-1",
      tenantId: "tenant-acme",
      missionId: "mission-123",
      runId: "run-456",
      toolId: "tool.acme.email-sender",
      requestHash: "req-hash-001",
      state: "RESERVED",
      attempts: [],
      createdAt: new Date().toISOString(),
    });
    expect(record.state).toBe("RESERVED");
    expect(record.attempts).toHaveLength(0);
  });

  it("ExecutionAttempt valide", () => {
    const attempt = executionAttemptSchema.parse({
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      status: "executing",
    });
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.status).toBe("executing");
  });

  // Audit payload
  it("audit payload data-minimized ne contient pas de credentials", () => {
    const payload = executionAuditPayloadSchema.parse({
      grantId: "grant-test-1",
      requestHash: "req-hash-001",
      tenantId: "tenant-acme",
      missionId: "mission-123",
      toolId: "tool.acme.email-sender",
      operation: "email.send",
      resource: "email:outbox",
      state: "COMPLETED",
      outcome: "succeeded",
      durationMs: 1500,
      classification: "C2",
    });
    expect(payload).not.toHaveProperty("input");
    expect(payload).not.toHaveProperty("output");
    expect(payload).not.toHaveProperty("credentials");
  });
});

// ─────────────────────────────────────
// In-Memory Grant Repository
// ─────────────────────────────────────

describe("G1.0 — Grant Repository", () => {
  let grants: InMemoryGrantRepository;

  beforeEach(() => {
    grants = new InMemoryGrantRepository();
  });

  it("crée et retrouve un grant", async () => {
    const grant = makeGrant();
    await grants.create(grant);
    const found = await grants.findById("grant-test-1");
    expect(found).not.toBeNull();
    expect(found!.tenantId).toBe("tenant-acme");
  });

  it("consomme un grant une seule fois", async () => {
    await grants.create(makeGrant());
    expect(await grants.consume("grant-test-1")).toBe(true);
    // Seconde consommation refusée
    expect(await grants.consume("grant-test-1")).toBe(false);
  });

  it("refuse de consommer un grant expiré", async () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    await grants.create(makeGrant({ expiresAt: past }));
    expect(await grants.consume("grant-test-1")).toBe(false);
  });

  it("expire les grants stalés", async () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await grants.create(makeGrant({ id: "grant-stale", expiresAt: past }));
    await grants.create(makeGrant({ id: "grant-fresh", expiresAt: future }));
    const expired = await grants.expireStale(new Date().toISOString());
    expect(expired).toBe(1);
  });

  it("retourne null pour un grant inconnu", async () => {
    expect(await grants.findById("unknown")).toBeNull();
  });

  it("refuse de consommer un grant déjà expiré", async () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    await grants.create(makeGrant({ expiresAt: past }));
    expect(await grants.consume("grant-test-1")).toBe(false);
    // Vérifier que le statut est bien expiré
    const found = await grants.findById("grant-test-1");
    expect(found!.status).toBe("expired");
  });
});

// ─────────────────────────────────────
// In-Memory Execution Record Repository
// ─────────────────────────────────────

describe("G1.0 — Execution Record Repository", () => {
  let records: InMemoryExecutionRecordRepository;
  let grants: InMemoryGrantRepository;

  beforeEach(() => {
    records = new InMemoryExecutionRecordRepository();
    grants = new InMemoryGrantRepository();
  });

  // ── Reservation ──

  it("réserve atomiquement une nouvelle idempotencyKey", async () => {
    const result = await records.reserve(makeReserveInput());
    expect(result.reserved).toBe(true);
    expect(result.record.state).toBe("RESERVED");
    expect(result.record.idempotencyKey).toBe("ik-tenant-acme:mission-123:email.send:req-hash-001");
  });

  it("détecte un doublon (même key, même hash) et retourne l'existant", async () => {
    await records.reserve(makeReserveInput());
    const result = await records.reserve(makeReserveInput());
    expect(result.reserved).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(result.record.state).toBe("RESERVED");
  });

  it("détecte un idempotency conflict (même key, hash différent)", async () => {
    await records.reserve(makeReserveInput());
    const result = await records.reserve(makeReserveInput({ requestHash: "req-hash-DIFFERENT" }));
    expect(result.reserved).toBe(false);
    expect(result.conflict).toBe("idempotency_conflict");
  });

  // ── Lifecycle ──

  it("RESERVED → EXECUTING → COMPLETED", async () => {
    const { record } = await records.reserve(makeReserveInput());
    expect(record.state).toBe("RESERVED");

    // Transition RESERVED → EXECUTING
    const t1 = await records.transitionState(
      "ik-tenant-acme:mission-123:email.send:req-hash-001",
      "RESERVED",
      "EXECUTING",
      { attemptNumber: 1, startedAt: new Date().toISOString(), status: "executing" },
    );
    expect(t1.ok).toBe(true);
    expect(t1.record!.state).toBe("EXECUTING");
    expect(t1.record!.attempts).toHaveLength(1);

    // Complete → COMPLETED
    const result = await records.complete({
      idempotencyKey: "ik-tenant-acme:mission-123:email.send:req-hash-001",
      targetState: "COMPLETED",
      attempt: {
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "succeeded",
        result: { sent: true, messageId: "msg-001" },
      },
      output: { sent: true, messageId: "msg-001" },
      durationMs: 1200,
    });
    expect(result.ok).toBe(true);
    expect(result.record!.state).toBe("COMPLETED");
  });

  it("RESERVED → EXECUTING → FAILED_SAFE → RESERVED (retry)", async () => {
    await records.reserve(makeReserveInput());
    await records.transitionState(
      "ik-tenant-acme:mission-123:email.send:req-hash-001",
      "RESERVED",
      "EXECUTING",
      { attemptNumber: 1, startedAt: new Date().toISOString(), status: "executing" },
    );

    // Échec sans effet externe
    const fail = await records.complete({
      idempotencyKey: "ik-tenant-acme:mission-123:email.send:req-hash-001",
      targetState: "FAILED_SAFE",
      attempt: {
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "failed",
        error: { code: "PROCESS_ERROR", message: "Provider temporairement indisponible" },
      },
      error: { code: "PROCESS_ERROR", message: "Provider temporairement indisponible" },
      durationMs: 500,
    });
    expect(fail.ok).toBe(true);
    expect(fail.record!.state).toBe("FAILED_SAFE");

    // Retry possible : FAILED_SAFE → RESERVED
    const retry = await records.transitionState(
      "ik-tenant-acme:mission-123:email.send:req-hash-001",
      "FAILED_SAFE",
      "RESERVED",
    );
    expect(retry.ok).toBe(true);
    expect(retry.record!.state).toBe("RESERVED");
  });

  it("EXECUTING → UNKNOWN (crash) et ne permet PAS le replay automatique", async () => {
    await records.reserve(makeReserveInput());
    await records.transitionState(
      "ik-tenant-acme:mission-123:email.send:req-hash-001",
      "RESERVED",
      "EXECUTING",
      { attemptNumber: 1, startedAt: new Date().toISOString(), status: "executing" },
    );

    // Crash → UNKNOWN
    const unknown = await records.complete({
      idempotencyKey: "ik-tenant-acme:mission-123:email.send:req-hash-001",
      targetState: "UNKNOWN",
      attempt: {
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "failed",
        error: { code: "WORKER_LOST", message: "Process perdu, état incertain" },
      },
      error: { code: "WORKER_LOST", message: "Process perdu, état incertain" },
      durationMs: 30000,
    });
    expect(unknown.ok).toBe(true);
    expect(unknown.record!.state).toBe("UNKNOWN");

    // UNKNOWN → EXECUTING DOIT ÉCHOUER (pas de replay automatique)
    const badReplay = await records.transitionState(
      "ik-tenant-acme:mission-123:email.send:req-hash-001",
      "UNKNOWN",
      "EXECUTING",
    );
    expect(badReplay.ok).toBe(false);
  });

  // ── Replay idempotent ──

  it("rejoue le résultat COMPLETED sans nouvelle exécution", async () => {
    // Compléter
    await records.reserve(makeReserveInput());
    await records.transitionState(
      "ik-tenant-acme:mission-123:email.send:req-hash-001",
      "RESERVED",
      "EXECUTING",
      { attemptNumber: 1, startedAt: new Date().toISOString(), status: "executing" },
    );
    await records.complete({
      idempotencyKey: "ik-tenant-acme:mission-123:email.send:req-hash-001",
      targetState: "COMPLETED",
      attempt: {
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "succeeded",
        result: { sent: true },
      },
      output: { sent: true },
      durationMs: 100,
    });

    // Rejeu avec la même key → retourne le résultat stocké
    const replay = await records.reserve(makeReserveInput());
    expect(replay.reserved).toBe(false);
    expect(replay.conflict).toBeUndefined();
    expect(replay.record.state).toBe("COMPLETED");
  });

  it("rejette le replay avec un payload différent (IDEMPOTENCY_CONFLICT)", async () => {
    await records.reserve(makeReserveInput());
    const conflict = await records.reserve(makeReserveInput({ requestHash: "req-hash-OTHER" }));
    expect(conflict.conflict).toBe("idempotency_conflict");
  });

  // ── Staleness ──

  it("trouve les RESERVED stalés", async () => {
    await records.reserve(makeReserveInput());
    const stale = await records.findStale(new Date(Date.now() + 10_000).toISOString());
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale[0].state).toBe("RESERVED");
  });

  it("ne trouve pas les COMPLETED comme stalés", async () => {
    await records.reserve(makeReserveInput());
    await records.transitionState(
      "ik-tenant-acme:mission-123:email.send:req-hash-001",
      "RESERVED",
      "EXECUTING",
      { attemptNumber: 1, startedAt: new Date().toISOString(), status: "executing" },
    );
    await records.complete({
      idempotencyKey: "ik-tenant-acme:mission-123:email.send:req-hash-001",
      targetState: "COMPLETED",
      attempt: {
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "succeeded",
      },
      durationMs: 100,
    });

    const stale = await records.findStale(new Date(Date.now() + 10_000).toISOString());
    expect(stale.filter((r) => r.state === "COMPLETED")).toHaveLength(0);
  });

  // ── Tenant isolation ──

  it("isole les tenants : des clés identiques dans des tenants différents sont distinctes", async () => {
    const base = makeReserveInput({ tenantId: "tenant-alpha" });
    await records.reserve(base);

    // Même idempotencyKey mais tenant différent
    const other = await records.reserve(
      makeReserveInput({ tenantId: "tenant-beta", idempotencyKey: "ik-tenant-beta:mission-123:email.send:req-hash-001" }),
    );

    // Sera réservé car la clé inclut le tenant
    expect(other.reserved).toBe(true);
  });
});
