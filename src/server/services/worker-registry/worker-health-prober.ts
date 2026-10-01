import type {
  WorkerProbeOutcome,
  WorkerRegistryEntry,
  WorkerRuntimeDescriptor,
} from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import type { WorkerRegistrationService } from "./worker-registration-service";
import { HEALTH_EVIDENCE_MAX_AGE_MS } from "@/core/workers/worker-eligibility";

/**
 * Autonomous worker health probing (M5.2, defect 14).
 *
 * M5.1 built a write side that could RECORD probe evidence
 * (WorkerRegistrationService.probe) but nothing PRODUCED any, so every
 * registered worker stayed `unknown` forever and the whole fleet was
 * permanently ineligible. Correct failure direction, but not orchestration.
 * This is the loop.
 *
 * TWO MOVEMENTS, BOTH REQUIRED
 *   probeAll()            — refreshes evidence for active workers.
 *   expireStaleEvidence() — invalidates evidence that nothing refreshed.
 * The second is what makes a crashed worker, a dead session or a stopped prober
 * fail CLOSED rather than leave a stale `healthy` behind. Probing alone cannot
 * do it: a worker that has stopped answering also stops being probed, so
 * without expiry its last good verdict would survive forever — including across
 * a process restart, which is exactly how a restart "magically restores
 * HEALTHY".
 *
 * EVIDENCE IS DURABLE, NEVER CACHED
 * Every verdict goes through the registration service into the `workers` table.
 * There is no in-memory health map: one would be invisible to other processes
 * and lost on restart, reintroducing the M4 snapshot bug that decision 0032
 * closed.
 *
 * KEYED BY RUNTIME, NOT BY WORKER KIND
 * Probe adapters are DATA, injected and keyed by `runtime` — the axis that
 * actually determines HOW you check something: you probe a binary by running it,
 * a container runtime by asking the daemon. A worker KIND says what the worker is
 * FOR, which tells you nothing about how to verify it.
 *
 * The practical consequence is that a brand-new worker kind is probeable with NO
 * new adapter and NO code change here, as long as its runtime is already
 * covered. Keying by kind would have required one registration per kind — which
 * is how a "routing" layer slowly accumulates a list of provider names.
 *
 * A runtime with NO adapter is recorded `unsupported` and routes nothing: we
 * cannot verify it, so we do not pretend to. Silently treating "unprobeable" as
 * "fine" is the fail-open hole decision 0031 exists to prevent.
 *
 * SCOPE — this probes WORKERS (execution units) THROUGH their runtime. Model,
 * provider, account and capacity-slot health are different axes and belong to the
 * Resource Manager; an adapter may consult them internally but must answer only
 * for the worker.
 */

/** What an adapter observed. Deliberately just the two routing gates. */
export interface WorkerHealthObservation {
  health: WorkerRegistryEntry["health"];
  availability: WorkerRegistryEntry["availability"];
}

/**
 * Observes one worker.
 *
 * Throwing is a legitimate, expected outcome: it is recorded as a FAILED probe
 * (unhealthy + unavailable), never swallowed and never read as "no evidence".
 */
export interface WorkerHealthProbePort {
  probe(worker: WorkerRegistryEntry): Promise<WorkerHealthObservation>;
}

export interface WorkerHealthProberOptions {
  /** Adapters keyed by RUNTIME. A runtime absent here is `unsupported`. */
  adapters?: Readonly<Partial<Record<WorkerRuntimeDescriptor, WorkerHealthProbePort>>>;
  /**
   * Selects a probe from the WORKER rather than from its runtime, consulted FIRST.
   *
   * Runtime is the right axis for "can this runtime execute here", and the wrong one for a
   * MODEL behind a gateway: every compute candidate declares `runtime: "binary"`, so the
   * runtime map cannot tell a model apart from a real binary worker. This selector is how
   * a model is probed over HTTP while binary workers keep the command probe, with no
   * provider name anywhere in the decision — it reads canonical metadata only.
   *
   * Returning `undefined` means "this worker is not mine", and the runtime map then
   * answers for it. That is SELECTION, not fallback: it happens before any request is
   * made, and once a probe is chosen a failure of that probe is recorded as a failure.
   * Nothing retries the same worker through a different adapter, because doing so would
   * let a gateway outage silently restore the host authority the HTTP probe removes.
   */
  selectProbe?: (worker: WorkerRegistryEntry) => WorkerHealthProbePort | undefined;
  /** How long probe evidence stays valid. Defaults to the canonical horizon. */
  maxEvidenceAgeMs?: number;
  now?: () => Date;
}

export interface WorkerProbeRecord {
  workerId: string;
  outcome: WorkerProbeOutcome;
  health: WorkerRegistryEntry["health"];
  availability: WorkerRegistryEntry["availability"];
  /** Present only for a failed probe. */
  error?: string;
}

export interface WorkerHealthSweepReport {
  /** One record per worker acted on, sorted by worker id. Deterministic evidence. */
  probed: WorkerProbeRecord[];
  /** Workers whose evidence expired and was durably invalidated, sorted by id. */
  expired: string[];
}

/** Simultaneous probes. Small: model probes share one gateway account's rate limit. */
export const PROBE_CONCURRENCY = 6;

export class WorkerHealthProber {
  private readonly adapters: Readonly<Partial<Record<WorkerRuntimeDescriptor, WorkerHealthProbePort>>>;
  private readonly selectProbe?: (worker: WorkerRegistryEntry) => WorkerHealthProbePort | undefined;
  private readonly maxEvidenceAgeMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly workers: WorkerRegistryStore,
    private readonly registration: WorkerRegistrationService,
    options: WorkerHealthProberOptions = {},
  ) {
    this.adapters = options.adapters ?? {};
    this.selectProbe = options.selectProbe;
    this.maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? HEALTH_EVIDENCE_MAX_AGE_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Probes every ACTIVE worker once and records the result durably.
   *
   * Inactive workers are skipped on purpose: they are already out of rotation,
   * and rewriting their evidence would destroy the audit trail `deactivate()`
   * deliberately preserves.
   */
  async probeAll(): Promise<WorkerProbeRecord[]> {
    const pool = await this.workers.list();
    /*
     * CONCURRENTLY, BOUNDED (decision 0054). Probes are independent — one row each — and a model
     * probe is a real LLM round-trip: in sequence, one hung model (a quota-exhausted route makes
     * the agent CLI retry until its probe timeout) delays every probe behind it past the
     * evidence horizon, and HEALTHY workers go stale. Unbounded, N simultaneous probes against
     * one gateway account can throttle it and fail every worker at once. Hence a small pool.
     */
    const active = pool.filter((w) => w.status === "active");
    const records: WorkerProbeRecord[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, active.length) }, async () => {
        while (next < active.length) records.push(await this.probeOne(active[next++]!));
      }),
    );

    return records.sort((a, b) => a.workerId.localeCompare(b.workerId));
  }

  private async probeOne(worker: WorkerRegistryEntry): Promise<WorkerProbeRecord> {
    /* Worker-level selection wins; the runtime map answers for whatever it declines. */
    const adapter = this.selectProbe?.(worker) ?? this.adapters[worker.runtime];

    if (!adapter) {
      // We cannot verify this runtime. Say exactly that, and route nothing to it.
      await this.registration.probe(worker.id, {
        health: "unknown",
        availability: "unknown",
        outcome: "unsupported",
      });
      return {
        workerId: worker.id,
        outcome: "unsupported",
        health: "unknown",
        availability: "unknown",
      };
    }

    try {
      const observed = await adapter.probe(worker);
      await this.registration.probe(worker.id, { ...observed, outcome: "ok" });
      return {
        workerId: worker.id,
        outcome: "ok",
        health: observed.health,
        availability: observed.availability,
      };
    } catch (error) {
      /*
       * A probe that threw is a NEGATIVE observation, not a missing one. The
       * runtime or provider behind this worker did not answer, so the worker is
       * unhealthy and unavailable until it does. This is the branch that stops
       * a transport error from silently passing as health.
       */
      await this.registration.probe(worker.id, {
        health: "unhealthy",
        availability: "unavailable",
        outcome: "failed",
      });
      return {
        workerId: worker.id,
        outcome: "failed",
        health: "unhealthy",
        availability: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Durably invalidates evidence older than the horizon.
   *
   * This is the crash/session-death path. A worker that stops answering also
   * stops being probed, so nothing would otherwise overwrite its last
   * `healthy`. After expiry the row reads unknown/unknown/`stale` and the
   * canonical matcher refuses it — including in a fresh process that never saw
   * the worker healthy, which is what makes "restart cannot restore HEALTHY"
   * true of the STORED STATE and not merely of one router instance.
   *
   * Already-`stale` rows are not rewritten: expiry is idempotent and must not
   * churn `updated_at` on every sweep.
   */
  async expireStaleEvidence(): Promise<string[]> {
    const reference = this.now().getTime();
    const expired: string[] = [];

    for (const worker of await this.workers.list()) {
      if (worker.status !== "active" || worker.lastProbeOutcome === "stale") {
        continue;
      }

      const probedAt = worker.lastProbeAt ? Date.parse(worker.lastProbeAt) : Number.NaN;
      const undatable = Number.isNaN(probedAt);
      const tooOld = !undatable && reference - probedAt > this.maxEvidenceAgeMs;

      // Never-probed rows are already fail-closed (unknown/unknown/never);
      // leave them, so "never looked" stays distinguishable from "expired".
      if (worker.lastProbeOutcome === "never" && !worker.lastProbeAt) {
        continue;
      }

      if (undatable || tooOld) {
        await this.registration.probe(worker.id, {
          health: "unknown",
          availability: "unknown",
          outcome: "stale",
        });
        expired.push(worker.id);
      }
    }

    return expired.sort((a, b) => a.localeCompare(b));
  }

  /** Refresh first, then invalidate whatever the refresh did not touch. */
  async sweep(): Promise<WorkerHealthSweepReport> {
    const probed = await this.probeAll();
    const expired = await this.expireStaleEvidence();
    return { probed, expired };
  }
}
