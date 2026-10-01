import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import {
  sameWorkerDeclaration,
  type WorkerRegistrationInput,
  type WorkerRegistrationService,
} from "@/server/services/worker-registry/worker-registration-service";
import {
  candidateRegistration,
  classifyModels,
  listOmniRouteModels,
  representativeModels,
  type CandidateRegistrationOptions,
  type DiscoveredModel,
} from "@/server/workers/compute-fleet";

/**
 * THE CANONICAL COMPUTE FLEET BOOTSTRAP (live-worker bootstrap lane).
 *
 * `compute-fleet.ts` turns provider truth into candidate declarations, and
 * `WorkerRegistrationService` writes one worker. Nothing sat between them: the
 * only way the declared fleet ever reached a registry was an operator running
 * `pnpm compute:register`, or the self-build E2E fixture doing the same four
 * calls by hand. A deployment that nobody ran the CLI against therefore has ZERO
 * workers, probes an empty fleet forever, and reads as a routing bug.
 *
 * This module is that missing step, and it is deliberately split in two:
 *
 *   plan()  — PURE. Takes the discovered models and the registry as it is, and
 *             says what WOULD change. Writes nothing, so it is the dry-run.
 *   apply() — Replays exactly that plan through the canonical service.
 *
 * One planner, two callers (the CLI's report and its `--apply`), because a
 * dry-run computed by different code than the write is a dry-run that can lie.
 *
 * WHAT IT DOES NOT DO
 * It never marks anything healthy, available or routable. A bootstrapped worker
 * is `health: unknown` / `lastProbeOutcome: never` and routes nothing until the
 * durable `probe_workers` sweep gets a real answer from it. The three claims stay
 * separate on purpose:
 *   catalog presence  != registered   (the provider lists it; we declared it)
 *   registered        != available    (declared; never observed)
 *   available         != routable     (observed; still gated on capacity, status,
 *                                      runtime support and evidence freshness)
 *
 * TENANCY / ENVIRONMENT. The `workers` table has no tenant column: a worker is a
 * runtime execution unit, not tenant data, and isolation is per DATABASE. The
 * bootstrap inherits whatever `DATABASE_URL` the process resolved and can reach
 * no other environment — which is also why nothing here can copy a row from one
 * database to another.
 */

/** A registry row this bootstrap owns. `compute:` is the prefix `candidateRegistration` writes. */
const COMPUTE_DISPLAY_PREFIX = "compute:";

export function isComputeCandidate(worker: WorkerRegistryEntry): boolean {
  return worker.displayName.startsWith(COMPUTE_DISPLAY_PREFIX);
}

export interface PlannedWorker {
  id: string;
  model: string;
  provider: string;
  family: string;
  declaration: WorkerRegistrationInput;
}

export interface ComputeBootstrapPlan {
  /** Where the declaration came from. A gateway ORIGIN, never a credential. */
  source: string;
  /** Model ids the provider listed, before classification. */
  listed: number;
  /** Absent from the registry: these rows would be created. */
  register: PlannedWorker[];
  /** Present with a DIFFERENT declaration: the row would be rewritten (evidence reset). */
  update: PlannedWorker[];
  /** Present and identical: no write at all, probe evidence preserved. */
  unchanged: PlannedWorker[];
  /**
   * Candidates the provider no longer serves. REPORTED, never written.
   *
   * Taking a worker out of rotation is a governed decision (the `DISABLE_WORKER`
   * control command, risk MEDIUM) and it is not this reconciler's to make. It does
   * not need to be, either: a withdrawn model's own probe fails within one sweep, so
   * the canonical matcher stops routing to it on EVIDENCE rather than on a boot-time
   * guess. Nothing is deleted — the declaration and the last probe stay as audit.
   *
   * ALWAYS EMPTY when `discovery` is `EMPTY` — see that field.
   */
  orphan: Array<{ id: string; displayName: string }>;
  /**
   * Declared candidates whose registry row is NOT active — almost always a worker an
   * operator disabled from the cockpit.
   *
   * LEFT ENTIRELY ALONE. Re-registering one would flip it back to `active`, so a
   * bootstrap that ran on every boot would silently undo a deliberate
   * `DISABLE_WORKER` at the next restart. A disabled worker comes back through the
   * governed `ENABLE_WORKER` command, which resets its evidence, and the bootstrap
   * reconciles its declaration on the boot after that.
   */
  disabled: Array<{ id: string; displayName: string; status: string }>;
  /**
   * Whether the provider's answer is usable as a statement about what exists.
   *
   * `EMPTY` means the listing produced NO candidate at all — an HTTP 200 with an
   * empty `data` array, a credential scoped to nothing, or a listing in which no id
   * is of a recognised family. That is not the provider saying "these models are
   * gone"; it is the provider telling us nothing, and the two must not be confused:
   * read as withdrawal it would deactivate the ENTIRE fleet on one bad response.
   * So orphan reconciliation is SUSPENDED for an empty discovery. The throw paths in
   * `discoverComputeFleet` cover an outage that announces itself; this covers the one
   * that arrives as a success.
   */
  discovery: "OK" | "EMPTY";
  /**
   * Already-registered candidates whose own evidence says they cannot take work.
   * REPORTED, never acted on: health belongs to the prober, and a bootstrap that
   * "fixed" availability would be asserting exactly what it must not assert.
   */
  unavailable: Array<{ id: string; displayName: string; health: string; outcome: string }>;
  /**
   * Shared capacity pools the plan implies. `candidateRegistration` sets the pool
   * to the PROVIDER, so this is also the plan's provider dependency list: every
   * model behind one provider account competes for one ceiling instead of
   * multiplying it. `declaredConcurrency` is the demand those workers declare, not
   * a quota — no provider quota is known here.
   */
  pools: Array<{ pool: string; workers: number; declaredConcurrency: number }>;
}

export interface ComputeBootstrapPlanInput {
  source: string;
  listed: readonly string[];
  existing: readonly WorkerRegistryEntry[];
  options: CandidateRegistrationOptions;
}

/**
 * What a bootstrap WOULD do. Pure: no I/O, no clock, no randomness, so the report
 * an operator reads is the same computation the write replays.
 */
export function planComputeBootstrap(input: ComputeBootstrapPlanInput): ComputeBootstrapPlan {
  const discovered = representativeModels(classifyModels(input.listed));
  const byId = new Map(input.existing.map((w) => [w.id, w]));

  const plan: ComputeBootstrapPlan = {
    source: input.source,
    listed: input.listed.length,
    register: [],
    update: [],
    unchanged: [],
    orphan: [],
    disabled: [],
    discovery: discovered.length > 0 ? "OK" : "EMPTY",
    unavailable: [],
    pools: [],
  };

  const declaredIds = new Set<string>();
  for (const model of discovered) {
    const declaration = candidateRegistration(model, input.options);
    declaredIds.add(declaration.id);
    const planned: PlannedWorker = {
      id: declaration.id,
      model: model.modelId,
      provider: model.provider,
      family: model.family,
      declaration,
    };
    const current = byId.get(declaration.id);
    if (!current) plan.register.push(planned);
    else if (current.status !== "active") {
      plan.disabled.push({
        id: current.id,
        displayName: current.displayName,
        status: current.status,
      });
    } else if (!sameWorkerDeclaration(current, declaration)) plan.update.push(planned);
    else plan.unchanged.push(planned);
  }

  if (plan.discovery === "OK") {
    for (const worker of input.existing) {
      if (!isComputeCandidate(worker) || declaredIds.has(worker.id)) continue;
      if (worker.status === "inactive") continue;
      plan.orphan.push({ id: worker.id, displayName: worker.displayName });
    }
  }

  for (const worker of input.existing) {
    if (!declaredIds.has(worker.id)) continue;
    if (worker.availability === "available" && worker.health === "healthy") continue;
    plan.unavailable.push({
      id: worker.id,
      displayName: worker.displayName,
      health: worker.health,
      outcome: worker.lastProbeOutcome,
    });
  }

  const pools = new Map<string, { workers: number; declaredConcurrency: number }>();
  for (const planned of [...plan.register, ...plan.update, ...plan.unchanged]) {
    const pool = planned.declaration.capacityPool;
    if (!pool) continue;
    const current = pools.get(pool) ?? { workers: 0, declaredConcurrency: 0 };
    pools.set(pool, {
      workers: current.workers + 1,
      declaredConcurrency: current.declaredConcurrency + (planned.declaration.maxConcurrency ?? 1),
    });
  }
  plan.pools = [...pools.entries()]
    .map(([pool, v]) => ({ pool, ...v }))
    .sort((a, b) => a.pool.localeCompare(b.pool));

  plan.register.sort((a, b) => a.model.localeCompare(b.model));
  plan.update.sort((a, b) => a.model.localeCompare(b.model));
  plan.unchanged.sort((a, b) => a.model.localeCompare(b.model));
  plan.orphan.sort((a, b) => a.displayName.localeCompare(b.displayName));
  plan.disabled.sort((a, b) => a.displayName.localeCompare(b.displayName));
  plan.unavailable.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return plan;
}

export interface ComputeBootstrapResult {
  registered: string[];
  updated: string[];
  /** Ids the plan left alone. Counted, so a restart proving "0 writes" is visible. */
  unchanged: string[];
  /** Declared but not active: reported, deliberately not written. */
  skippedDisabled: string[];
}

/**
 * Replays a plan through the canonical service.
 *
 * It writes DECLARATIONS and nothing else: never a health or availability value, and
 * never a `status`. `register()` is a no-op for an unchanged declaration, so
 * `unchanged` is not written at all — that is what makes calling this on every boot
 * restart-safe instead of evidence-destroying.
 */
export async function applyComputeBootstrap(
  registration: WorkerRegistrationService,
  plan: ComputeBootstrapPlan,
): Promise<ComputeBootstrapResult> {
  const registered: string[] = [];
  const updated: string[] = [];

  for (const planned of plan.register) {
    await registration.register(planned.declaration);
    registered.push(planned.id);
  }
  for (const planned of plan.update) {
    await registration.register(planned.declaration);
    updated.push(planned.id);
  }

  return {
    registered,
    updated,
    unchanged: plan.unchanged.map((p) => p.id),
    skippedDisabled: plan.disabled.map((d) => d.id),
  };
}

export interface DiscoverComputeFleetOptions {
  baseUrl: string;
  credential: string;
  options: CandidateRegistrationOptions;
  workers: WorkerRegistryStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Discovers the fleet from the provider and plans against the live registry.
 *
 * FAILS SAFE, LOUDLY: if the provider cannot be reached or refuses, this THROWS and
 * no plan exists, so `apply` is never reached and the registry is untouched. The
 * outage that arrives as a SUCCESS — a 200 whose listing yields no candidate — is
 * caught by the planner instead (`discovery: "EMPTY"`).
 */
export async function discoverComputeFleet(
  opts: DiscoverComputeFleetOptions,
): Promise<ComputeBootstrapPlan> {
  const listed = await listOmniRouteModels({
    baseUrl: opts.baseUrl,
    credential: opts.credential,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
  });
  return planComputeBootstrap({
    source: new URL(opts.baseUrl).origin,
    listed,
    existing: await opts.workers.list(),
    options: opts.options,
  });
}

/** The capabilities a compute candidate is declared with when nothing overrides them. */
export const DEFAULT_COMPUTE_CAPABILITIES = [
  "code_editing",
  "documentation",
  "analysis",
  "review",
] as const;

export type { DiscoveredModel };
