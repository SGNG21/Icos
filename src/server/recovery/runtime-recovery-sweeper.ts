import { randomUUID } from "node:crypto";
import type { RuntimeControlGuard } from "@/server/control/runtime-control";

import type {
  RecoveryDispatchRef,
  RecoveryScanner,
  RecoveryUnitRef,
  RecoveryUnitRepository,
  WorkflowProbe,
} from "@/core/contracts/recovery";
import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";

/** Effets de reprise. Tous idempotents (ADR-0027 §3) ; branchés sur les services existants en composition. */
export interface RuntimeRecoveryActions {
  /** `AutonomyWakeupService.wake` : le runner reste l'arbitre d'exécution (lease de runtime). */
  wake(missionId: string): Promise<unknown>;
  /** `SupervisorService.reconcilePreparedDispatches` : `claimPrepared` + même workflowId. */
  reconcileDispatches(missionId: string): Promise<void>;
  /** Redémarre le workflow avec le MÊME workflowId (Temporal : REJECT_DUPLICATE + FAIL). */
  redispatch(attempt: RecoveryDispatchRef): Promise<void>;
  /** Enregistre un ÉCHEC worker (jamais un succès) ; le QC décide ensuite (retry borné). */
  recordLostExecution(attempt: RecoveryDispatchRef): Promise<void>;
  /**
   * M7 — settles an external worker execution abandoned by its runner, FREEING the
   * worker's capacity slot. The bounded retry stays the QC's decision, as above.
   */
  reclaimAbandonedExecution(attempt: RecoveryDispatchRef): Promise<void>;
}

export interface RuntimeRecoveryOptions {
  leaseMs: number;
  maxAttempts: number;
  /** Ancienneté avant qu'un état soit jugé abandonné ; aussi cooldown d'un `defer`. */
  graceMs: number;
  /** Ancienneté d'un dispatch `dispatched` sans résultat avant sonde du workflow. */
  orphanAfterMs: number;
  /**
   * M7 — grace period AFTER an execution lease expires before the attempt is declared
   * abandoned. Short, because an expired lease is already strong evidence: a live
   * runner renews it. Not zero, so a runner finishing a long commit is not reclaimed
   * out from under itself.
   */
  abandonedExecutionGraceMs: number;
  backoffBaseMs: number;
}

export const DEFAULT_RUNTIME_RECOVERY_OPTIONS: RuntimeRecoveryOptions = {
  leaseMs: 5 * 60_000,
  maxAttempts: 5,
  graceMs: 60_000,
  orphanAfterMs: 10 * 60_000,
  abandonedExecutionGraceMs: 60_000,
  backoffBaseMs: 30_000,
};

type Verdict = { outcome: "resolved" | "deferred"; reason: string; cooldownMs?: number };

/** Code d'erreur stable persisté : jamais de message brut (pas de fuite de secret / prompt). */
function stableCode(error: unknown): string {
  const match = error instanceof Error ? /^[A-Z][A-Z0-9_]{2,63}/.exec(error.message) : null;
  return match ? match[0] : "RECOVERY_ACTION_FAILED";
}

/**
 * Détecte les états abandonnés (scans PostgreSQL bornés), revendique chaque unité de façon durable
 * (`recovery_units`) puis délègue l'effet aux services canoniques. Complète — sans les remplacer —
 * `AutonomyRecoverySweeper` (runtimes `running`), `QualityControlRecoverySweeper` (QC + outbox) et
 * `DurableScheduler` (jobs 7A). Une unité en échec n'empêche jamais les suivantes.
 */
export class RuntimeRecoverySweeper {
  private readonly options: RuntimeRecoveryOptions;

  constructor(
    private readonly scanner: RecoveryScanner,
    private readonly units: RecoveryUnitRepository,
    private readonly actions: RuntimeRecoveryActions,
    private readonly probe?: WorkflowProbe,
    options: Partial<RuntimeRecoveryOptions> = {},
    /** Runtime control (decision 0055): a held redispatch is deferred, never failed. */
    private readonly control?: Pick<RuntimeControlGuard, "dispatch">,
  ) {
    this.options = { ...DEFAULT_RUNTIME_RECOVERY_OPTIONS, ...options };
  }

  async sweep(limit = 100): Promise<AutonomyRecoverySweepResult> {
    const { graceMs, orphanAfterMs } = this.options;
    const candidates: Array<{ unit: RecoveryUnitRef; run: () => Promise<Verdict> }> = [];

    for (const w of await this.scanner.listSettledWaiting({ limit, olderThanMs: graceMs })) {
      candidates.push({
        unit: {
          kind: "waiting_settled",
          key: `${w.missionId}@${w.settledSince.getTime()}`,
          missionId: w.missionId,
        },
        run: () => this.wake(w.missionId),
      });
    }
    for (const a of await this.scanner.listStalePrepared({ limit, olderThanMs: graceMs })) {
      candidates.push({
        unit: { kind: "dispatch_prepared_stale", key: a.id, missionId: a.missionId },
        run: async () => {
          await this.actions.reconcileDispatches(a.missionId);
          return { outcome: "resolved", reason: "PREPARED_REPLAYED" };
        },
      });
    }
    for (const a of await this.scanner.listOrphanedDispatched({
      limit,
      olderThanMs: orphanAfterMs,
    })) {
      candidates.push({
        unit: { kind: "dispatch_orphaned", key: a.workflowId, missionId: a.missionId },
        run: () => this.orphan(a),
      });
    }

    /*
     * M7 — abandoned EXTERNAL WORKER executions (decision 0039).
     *
     * Deliberately a SEPARATE candidate source from `listOrphanedDispatched`, not a
     * widening of it. The orphan scan asks a `WorkflowProbe` whether a Temporal
     * workflow still exists; a process-based external worker has no workflow, so that
     * probe answers `unknown` and the unit defers FOR EVER. This scan uses the
     * execution lease instead, which a dead runner cannot renew — positive evidence
     * rather than an unanswerable question. That is the mechanism by which defect 17
     * survived M6.3.
     */
    for (const a of await this.scanner.listAbandonedExecutions({
      limit,
      olderThanMs: this.options.abandonedExecutionGraceMs,
    })) {
      candidates.push({
        unit: { kind: "dispatch_execution_abandoned", key: a.workflowId, missionId: a.missionId },
        run: async () => {
          await this.actions.reclaimAbandonedExecution(a);
          return { outcome: "resolved", reason: "ABANDONED_EXECUTION_RECLAIMED" };
        },
      });
    }

    const failures: AutonomyRecoverySweepResult["failures"] = [];
    let attempted = 0;
    let succeeded = 0;
    for (const { unit, run } of candidates) {
      const ownerToken = `recovery-${randomUUID()}`;
      const claim = await this.units.claim(
        unit,
        ownerToken,
        this.options.leaseMs,
        this.options.maxAttempts,
      );
      if (claim === "exhausted") {
        failures.push({ missionId: unit.missionId, error: new Error("RECOVERY_UNIT_EXHAUSTED") });
        continue;
      }
      if (claim !== "claimed") continue;

      attempted += 1;
      try {
        const verdict = await run();
        if (verdict.outcome === "resolved") {
          await this.units.complete(unit, ownerToken, verdict.reason);
        } else {
          await this.units.defer(unit, ownerToken, verdict.reason, verdict.cooldownMs ?? graceMs);
        }
        succeeded += 1;
      } catch (error) {
        await this.units.fail(unit, ownerToken, stableCode(error), this.options.backoffBaseMs);
        failures.push({ missionId: unit.missionId, error });
      }
    }

    return {
      discovered: candidates.length,
      attempted,
      succeeded,
      failed: failures.length,
      failures,
    };
  }

  private async wake(missionId: string): Promise<Verdict> {
    const result = await this.actions.wake(missionId);
    // A live owner exists: it will progress the mission (or crash into the lease-expiry path).
    if ((result as { reason?: string } | null)?.reason === "AUTONOMY_RUNTIME_ALREADY_OWNED") {
      return { outcome: "deferred", reason: "RUNTIME_OWNED" };
    }
    return { outcome: "resolved", reason: "WOKEN" };
  }

  private async orphan(attempt: RecoveryDispatchRef): Promise<Verdict> {
    // Fail closed: without a reliable probe, never guess that a worker is gone.
    const status = this.probe ? await this.probe.status(attempt.workflowId) : "unknown";
    switch (status) {
      case "not_found":
        if (this.control && !(await this.control.dispatch(attempt.missionId)).allowed) {
          // Held: re-examined after the cooldown, dispatched once released.
          return {
            outcome: "deferred",
            reason: "CONTROL_HELD",
            cooldownMs: this.options.orphanAfterMs,
          };
        }
        await this.actions.redispatch(attempt);
        // Re-examined later: if the restarted workflow vanishes again it is still covered.
        return {
          outcome: "deferred",
          reason: "REDISPATCHED",
          cooldownMs: this.options.orphanAfterMs,
        };
      case "closed":
        await this.actions.recordLostExecution(attempt);
        return { outcome: "resolved", reason: "LOST_EXECUTION_RECORDED" };
      default:
        return { outcome: "deferred", reason: `WORKFLOW_${status.toUpperCase()}` };
    }
  }
}
