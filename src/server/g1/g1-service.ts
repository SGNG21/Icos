import { randomUUID } from "node:crypto";

import type {
  ExecutionGrant,
  ExecutionRecordEvent,
  IdempotencyEntry,
  IdempotencyKey,
  IdempotencyState,
  PolicyProvenance,
  RequestHash,
} from "@/core/g1";
import {
  assertIdempotencyTransition,
  canAutoReplay,
  defaultIsolationRequirement,
  deriveIdempotencyKey,
  isStaleExecuting,
} from "@/core/g1";
import type {
  GrantRepository,
  IdempotencyStore,
  ExecutionRecordStore,
  G1UnitOfWork,
} from "@/server/g1/ports";
import type { AuditEntry } from "@/core/contracts/audit";
import type { AuditRepository } from "@/server/repositories/ports";

// ─────────────────────────────────────
// Types d'entrée
// ─────────────────────────────────────

export interface ReserveExecutionInput {
  tenantId: string;
  principalId: string;
  missionId: string;
  runId: string;
  toolId: string;
  toolDefinitionHash: string;
  toolVersion?: string;
  capability: string;
  operation: string;
  resource: string;
  requestHash: RequestHash;
  policyProvenance: PolicyProvenance;
  sensitivityLevel: "C0" | "C1" | "C2" | "C3";
}

export interface CompleteExecutionInput {
  idempotencyKey: IdempotencyKey;
  grantId?: string;
  outputHash?: string;
  artifactRefs?: string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    providerId?: string;
    model?: string;
  };
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  isSuccess: boolean;
}

// ─────────────────────────────────────
// Résultats
// ─────────────────────────────────────

export type ReserveResult =
  | {
      ok: true;
      idempotencyKey: IdempotencyKey;
      grant: ExecutionGrant;
      entry: IdempotencyEntry;
    }
  | {
      ok: false;
      code: "IDEMPOTENCY_CONFLICT" | "ALREADY_COMPLETED" | "GRANT_NOT_AVAILABLE" | "INVALID_STATE";
      message: string;
      replayResult?: unknown;
    };

export type StartResult =
  | {
      ok: true;
      entry: IdempotencyEntry;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "STALE_EXECUTING" | "CONCURRENT_LOCK";
      message: string;
    };

export type CompleteResult =
  | {
      ok: true;
      entry: IdempotencyEntry;
      recordId: string;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "NO_GRANT" | "TRANSACTION_FAILED";
      message: string;
    };

// ─────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────

function makeAuditEntry(
  eventType: AuditEntry["eventType"],
  details: Record<string, unknown>,
): AuditEntry {
  return {
    id: `aud-${randomUUID().slice(0, 8)}`,
    occurredAt: new Date().toISOString(),
    eventType,
    actor: { kind: "system", id: "g1-service" },
    details: details as Record<string, string | number | boolean | null>,
  };
}

// ─────────────────────────────────────
// G1 Service
// ─────────────────────────────────────

export class G1Service {
  private readonly MAX_STALE_MS = 300_000; // 5 minutes

  constructor(
    private readonly grants: GrantRepository,
    private readonly idempotency: IdempotencyStore,
    private readonly records: ExecutionRecordStore,
    private readonly audit: AuditRepository,
  ) {}

  // ─────────────────────────────────────
  // Réserver une exécution
  // ─────────────────────────────────────

  async reserve(input: ReserveExecutionInput): Promise<ReserveResult> {
    const ik = deriveIdempotencyKey({
      tenantId: input.tenantId,
      principalId: input.principalId,
      missionId: input.missionId,
      runId: input.runId,
    });

    // Vérifier si la clé existe déjà
    const existing = await this.idempotency.findByKey(ik);
    if (existing) {
      return this.handleExistingIdempotency(existing, input.requestHash);
    }

    // Créer le grant
    const grantId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString(); // TTL 1 minute

    const grant: ExecutionGrant = {
      id: grantId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      missionId: input.missionId,
      runId: input.runId,
      toolId: input.toolId,
      toolDefinitionHash: input.toolDefinitionHash,
      toolVersion: input.toolVersion,
      capability: input.capability,
      operation: input.operation,
      resource: input.resource,
      requestHash: input.requestHash,
      idempotencyKey: ik,
      policyProvenance: input.policyProvenance,
      credentialRequirements: [],
      networkRequirements: [],
      isolationRequirements: defaultIsolationRequirement,
      issuedAt: now.toISOString(),
      expiresAt,
      consumedAt: null,
    };

    // Réserver l'idempotence
    const entry: IdempotencyEntry = {
      idempotencyKey: ik,
      state: "RESERVED",
      requestHash: input.requestHash,
      tenantId: input.tenantId,
      principalId: input.principalId,
      missionId: input.missionId,
      runId: input.runId,
      sensitivityLevel: input.sensitivityLevel,
      grantId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const saved = await this.idempotency.reserve(entry);
    if (!saved) {
      return {
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Conflit d'idempotence : la clé a déjà été réservée",
      };
    }

    // Persister le grant
    await this.grants.save(grant);

    // Audit : réservation
    await this.audit.append(
      makeAuditEntry("tool.invocation_reserved", {
        idempotencyKey: ik,
        grantId,
        tenantId: input.tenantId,
        principalId: input.principalId,
        toolId: input.toolId,
        requestHash: input.requestHash,
        sensitivityLevel: input.sensitivityLevel,
      }),
    );

    return {
      ok: true,
      idempotencyKey: ik,
      grant,
      entry: saved,
    };
  }

  // ─────────────────────────────────────
  // Démarrer l'exécution (RESERVED → EXECUTING)
  // ─────────────────────────────────────

  async start(idempotencyKey: IdempotencyKey): Promise<StartResult> {
    const entry = await this.idempotency.findByKey(idempotencyKey);
    if (!entry) {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "Aucune entrée d'idempotence trouvée",
      };
    }

    // Vérifier les transitions autorisées
    try {
      assertIdempotencyTransition(entry.state, "EXECUTING");
    } catch {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: `Transition ${entry.state} → EXECUTING interdite`,
      };
    }

    // Vérifier les stale EXECUTING
    if (entry.state === "EXECUTING") {
      if (isStaleExecuting(entry.updatedAt, this.MAX_STALE_MS)) {
        // Stale EXECUTING → UNKNOWN
        const unknownEntry = await this.idempotency.transition(
          idempotencyKey,
          "EXECUTING",
          "UNKNOWN",
          {},
        );
        if (!unknownEntry) {
          return {
            ok: false,
            code: "CONCURRENT_LOCK",
            message: "Impossible de marquer EXECUTING stale → UNKNOWN",
          };
        }
        // Audit
        await this.audit.append(
          makeAuditEntry("tool.invocation_unknown", {
            idempotencyKey,
            tenantId: entry.tenantId,
            previousState: "EXECUTING",
            reason: "stale_executing",
          }),
        );
        return {
          ok: false,
          code: "STALE_EXECUTING",
          message: "État EXECUTING obsolète → UNKNOWN. Aucun rejeu automatique possible.",
        };
      }
      return {
        ok: false,
        code: "CONCURRENT_LOCK",
        message: "EXECUTING déjà en cours",
      };
    }

    // RESERVED → EXECUTING atomique
    const started = await this.idempotency.transition(idempotencyKey, "RESERVED", "EXECUTING", {
      requestHash: entry.requestHash,
    });

    if (!started) {
      return {
        ok: false,
        code: "CONCURRENT_LOCK",
        message: "Transition RESERVED → EXECUTING concurrente",
      };
    }

    // Audit : exécution démarrée
    await this.audit.append(
      makeAuditEntry("tool.invocation_started", {
        idempotencyKey,
        tenantId: entry.tenantId,
        runId: entry.runId,
      }),
    );

    return { ok: true, entry: started };
  }

  // ─────────────────────────────────────
  // Compléter l'exécution (EXECUTING → COMPLETED / FAILED_SAFE)
  // ─────────────────────────────────────
  //
  // Ordre atomique (respecte la spec G1.0) :
  // 1. Validation & grant consumption
  // 2. ExecutionRecord immuable (append) — persiste d'abord
  // 3. transition finale de l'IdempotencyState — valide ensuite
  //
  // L'ordre respecte l'invariant : COMPLETED seulement après résultat
  // durable. Si la transition d'état échoue après le record append,
  // l'état reste EXECUTING (sûr, récupérable).

  async complete(input: CompleteExecutionInput, uow?: G1UnitOfWork): Promise<CompleteResult> {
    const entry = await this.idempotency.findByKey(input.idempotencyKey);
    if (!entry) {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "Aucune entrée d'idempotence trouvée",
      };
    }

    const targetState: IdempotencyState = input.isSuccess ? "COMPLETED" : "FAILED_SAFE";

    // Vérifier la transition
    try {
      assertIdempotencyTransition(entry.state, targetState);
    } catch {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: `Transition ${entry.state} → ${targetState} interdite`,
      };
    }

    // Atomicité : COMPLETED nécessite résultat durable
    if (targetState === "COMPLETED" && !input.outputHash && !input.artifactRefs?.length) {
      return {
        ok: false,
        code: "TRANSACTION_FAILED",
        message: "COMPLETED requires a durable result or reference",
      };
    }

    // Consommer le grant si présent
    if (input.grantId) {
      const consumed = await this.grants.consumeAtomically(input.grantId);
      if (!consumed && targetState === "COMPLETED") {
        return {
          ok: false,
          code: "NO_GRANT",
          message: "Grant non disponible pour complétion",
        };
      }
    }

    // Construire le record d'exécution
    const events: ExecutionRecordEvent[] = [
      {
        type: "tool.invocation_reserved",
        occurredAt: entry.createdAt,
        data: { requestHash: entry.requestHash },
      },
      {
        type: "tool.invocation_started",
        occurredAt: entry.updatedAt,
        data: {},
      },
      {
        type: targetState === "COMPLETED" ? "tool.invocation_completed" : "tool.invocation_failed",
        occurredAt: new Date().toISOString(),
        data: {
          outputHash: input.outputHash,
          errorCode: input.errorCode,
          isSuccess: input.isSuccess,
        },
      },
    ];

    const recordId = `rec-${randomUUID()}`;

    const record = {
      id: recordId,
      tenantId: entry.tenantId,
      missionId: entry.missionId,
      runId: entry.runId,
      idempotencyKey: input.idempotencyKey,
      requestHash: entry.requestHash,
      grantId: input.grantId ?? entry.grantId,
      principalId: entry.principalId,
      sensitivityLevel: entry.sensitivityLevel,
      events,
      outputHash: input.outputHash,
      artifactRefs: input.artifactRefs ?? [],
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      durationMs: input.durationMs,
      usage: input.usage,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // UoW : snapshooter l'état avant les mutations critiques
    if (uow) {
      await uow.begin();
    }

    try {
      // 2. ExecutionRecord immuable (append) — persiste d'abord
      await this.records.append(record);

      // 3. Transition finale de l'IdempotencyState — valide ensuite
      const updated = await this.idempotency.transition(
        input.idempotencyKey,
        entry.state,
        targetState,
        {
          completedAt: new Date().toISOString(),
          replayResult: input.isSuccess ? { outputHash: input.outputHash } : undefined,
        },
      );

      // La transition a échoué : rollback pour annuler le record.append
      if (!updated) {
        if (uow) {
          await uow.rollback();
        }
        return {
          ok: false,
          code: "TRANSACTION_FAILED",
          message: "Échec de la transition atomique d'idempotence",
        };
      }

      // Audit INSIDE UoW — avant commit pour que le rollback
      // puisse annuler la transition et le record en cas d'échec
      const eventType =
        targetState === "COMPLETED" ? "tool.invocation_completed" : "tool.invocation_failed";

      await this.audit.append(
        makeAuditEntry(eventType, {
          idempotencyKey: input.idempotencyKey,
          recordId,
          outputHash: input.outputHash,
          errorCode: input.errorCode,
          durationMs: input.durationMs,
          isSuccess: input.isSuccess,
        }),
      );

      // Commit UoW : snapshot libéré, mutations définitives
      if (uow) {
        await uow.commit();
      }

      return { ok: true, entry: updated, recordId };
    } catch (err) {
      // Erreur inattendue : rollback pour préserver l'intégrité
      if (uow) {
        await uow.rollback();
      }
      return {
        ok: false,
        code: "TRANSACTION_FAILED",
        message: `Échec atomique de la complétion : ${(err as Error).message}`,
      };
    }
  }

  // ─────────────────────────────────────
  // Rejeu (COMPLETED → retourner résultat stocké)
  // ─────────────────────────────────────

  async replay(idempotencyKey: IdempotencyKey): Promise<{
    ok: boolean;
    code?: string;
    message: string;
    result?: unknown;
  }> {
    const entry = await this.idempotency.findByKey(idempotencyKey);
    if (!entry) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Aucune entrée trouvée",
      };
    }

    if (!canAutoReplay(entry.state)) {
      return {
        ok: false,
        code: "REPLAY_DENIED",
        message: `Le rejeu automatique n'est pas autorisé pour l'état ${entry.state}`,
      };
    }

    if (entry.state === "COMPLETED") {
      return {
        ok: true,
        message: "Rejeu idempotent : résultat déjà disponible",
        result: entry.replayResult,
      };
    }

    // FAILED_SAFE ou RESERVED stale → retourner l'état pour retry
    return {
      ok: true,
      message: `État ${entry.state} : retry possible`,
      result: { state: entry.state },
    };
  }

  // ─────────────────────────────────────
  // Gestionnaire clé existante
  // ─────────────────────────────────────

  private async handleExistingIdempotency(
    existing: IdempotencyEntry,
    requestHash: RequestHash,
  ): Promise<ReserveResult> {
    // Vérifier le requestHash
    if (existing.requestHash !== requestHash) {
      return {
        ok: false,
        code: "IDEMPOTENCY_CONFLICT",
        message: "La même clé d'idempotence avec un requestHash différent est un conflit",
      };
    }

    // COMPLETED → rejeu
    if (existing.state === "COMPLETED") {
      return {
        ok: false,
        code: "ALREADY_COMPLETED",
        message: "Déjà complété : rejeu idempotent disponible",
        replayResult: existing.replayResult,
      };
    }

    // FAILED_SAFE → retry possible
    if (existing.state === "FAILED_SAFE") {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "FAILED_SAFE : utilisez retry() pour relancer l'exécution",
      };
    }

    // RESERVED (stale) → peut être repris
    if (existing.state === "RESERVED") {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "RESERVED existe déjà : utilisez start() pour continuer ou retry si stale",
      };
    }

    // UNKNOWN → pas de rejeu automatique
    if (existing.state === "UNKNOWN") {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "UNKNOWN : aucune reprise automatique possible. Intervention manuelle requise.",
      };
    }

    // EXECUTING (en cours, pas stale)
    return {
      ok: false,
      code: "INVALID_STATE",
      message: "EXECUTING déjà en cours pour cette clé",
    };
  }
}
