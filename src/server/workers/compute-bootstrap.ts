import { randomUUID } from "node:crypto";

import type { AuditEntry } from "@/core/contracts/audit";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { AuditRepository } from "@/server/repositories/ports";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import {
  FLEET_RETIREMENT_METADATA_KEY,
  FLEET_RETIREMENT_ORPHAN,
  sameWorkerDeclaration,
  type WorkerRegistrationInput,
  type WorkerRegistrationService,
} from "@/server/services/worker-registry/worker-registration-service";
import {
  candidateRegistration,
  candidateWorkerId,
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

/**
 * A row THIS BOOTSTRAP CREATED, proven rather than guessed — the only rows the reconciler
 * may ever take out of rotation or put back.
 *
 * A `compute:` display name alone is a label anyone can type. The proof is that the row's
 * id is exactly the deterministic id `candidateWorkerId` derives from its own
 * `metadata.model`, AND its display name is exactly the one `candidateRegistration` writes
 * for that model. A manually registered worker does not satisfy both by accident, so it is
 * never retired automatically, whatever it is called.
 */
export function isFleetOwned(worker: WorkerRegistryEntry): boolean {
  const model = worker.metadata.model;
  return (
    typeof model === "string" &&
    model.length > 0 &&
    worker.displayName === `${COMPUTE_DISPLAY_PREFIX}${model}` &&
    worker.id === candidateWorkerId(model)
  );
}

/** Retired by the reconciler (and only by it): the one kind of inactive row it may reinstate. */
export function isFleetRetired(worker: WorkerRegistryEntry): boolean {
  return (
    worker.status !== "active" &&
    worker.metadata[FLEET_RETIREMENT_METADATA_KEY] === FLEET_RETIREMENT_ORPHAN &&
    isFleetOwned(worker)
  );
}

/** The audit actor of every reconciler status write. A system actor, never a human's name. */
export const FLEET_RECONCILER_ACTOR = { kind: "system", id: "compute-fleet-reconciler" } as const;

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
   * Candidates the provider no longer serves. The REPORT: every such row, whoever owns it.
   *
   * Only the subset in `retire` is ever written. Nothing is deleted — the declaration
   * and the probe date stay as audit.
   *
   * ALWAYS EMPTY when `discovery` is `EMPTY` — see that field.
   */
  orphan: Array<{ id: string; displayName: string }>;
  /**
   * Orphans the reconciler takes out of rotation (decision 0064, as extended by the P0
   * autonomy unblock). A row is retired only when ALL of these hold:
   *   - the bootstrap provably created it (`isFleetOwned`) — never a manual registration;
   *   - it is `active` — an operator's disable is never relabelled;
   *   - its OWN evidence does not say it works (not healthy+available). Absence from a
   *     listing is one signal; a model that still answers its probe is left alone, which
   *     is what keeps a PARTIAL listing (0064 point 5) from retiring a working model;
   *   - the retirement is not a mass withdrawal (see `retirement`).
   * Without this, a withdrawn model's row stayed `active` forever, counted as fleet in
   * every reader that did not apply the full matcher, and was never cleaned up.
   */
  retire: Array<{
    id: string;
    displayName: string;
    /** The evidence the retirement was decided on, recorded in its audit entry. */
    lastProbeOutcome: string;
    lastProbeErrorClass: string | null;
  }>;
  /**
   * Rows the reconciler itself retired that the provider lists AGAIN: put back through
   * `reactivate()` (evidence reset to "never probed", exactly like ENABLE_WORKER), then
   * reconciled to the current declaration. An operator-disabled row is never here.
   */
  reinstate: PlannedWorker[];
  /**
   * Whether `retire` may be written.
   *   OK                        — yes.
   *   WITHHELD_EMPTY_DISCOVERY  — the listing said nothing; no orphan exists.
   *   WITHHELD_MASS_WITHDRAWAL  — more than half of the active fleet-owned rows would be
   *                               retired at once. That is far likelier a bad listing than
   *                               a provider dropping most of its catalog, so `retire` is
   *                               emptied and the orphans stay REPORTED for an operator.
   */
  retirement: "OK" | "WITHHELD_EMPTY_DISCOVERY" | "WITHHELD_MASS_WITHDRAWAL";
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
   * gone"; it is the provider telling us nothing, and the two must not be confused.
   *
   * So `orphan` is left empty for it: reporting the ENTIRE fleet as withdrawn on one
   * bad response would be a false alarm, and with orphan retirement a fleet-wide write.
   * Note that a PARTIAL listing still reads `OK`, so `discovered.length > 0` is NOT a
   * sufficient signal for a write on its own: `retire` additionally requires the row's
   * own failing evidence and refuses a mass withdrawal.
   *
   * The throw paths in `discoverComputeFleet` cover an outage that announces itself;
   * this covers the one that arrives as a success.
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
    retire: [],
    reinstate: [],
    retirement: discovered.length > 0 ? "OK" : "WITHHELD_EMPTY_DISCOVERY",
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
    else if (isFleetRetired(current)) plan.reinstate.push(planned);
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
      const working = worker.health === "healthy" && worker.availability === "available";
      if (isFleetOwned(worker) && worker.status === "active" && !working) {
        plan.retire.push({
          id: worker.id,
          displayName: worker.displayName,
          lastProbeOutcome: worker.lastProbeOutcome,
          lastProbeErrorClass: worker.lastProbeErrorClass ?? null,
        });
      }
    }

    const fleetActive = input.existing.filter(
      (w) => isFleetOwned(w) && w.status === "active",
    ).length;
    if (plan.retire.length > 1 && plan.retire.length * 2 > fleetActive) {
      plan.retirement = "WITHHELD_MASS_WITHDRAWAL";
      plan.retire = [];
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
  for (const planned of [...plan.register, ...plan.update, ...plan.unchanged, ...plan.reinstate]) {
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
  plan.reinstate.sort((a, b) => a.model.localeCompare(b.model));
  plan.orphan.sort((a, b) => a.displayName.localeCompare(b.displayName));
  plan.retire.sort((a, b) => a.displayName.localeCompare(b.displayName));
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
  /** Orphans taken out of rotation, each with an audit entry. */
  retired: string[];
  /** Previously retired orphans listed again and put back, each with an audit entry. */
  reinstated: string[];
  /**
   * Status writes the plan asked for and this call did NOT make because no audit sink
   * was given: a status change without its audit entry is not a governed change.
   */
  skippedUnaudited: string[];
  /** The plan's retirement verdict, so a withheld mass withdrawal reaches the operator log. */
  retirement: ComputeBootstrapPlan["retirement"];
}

export interface ComputeBootstrapGovernance {
  /** Where every retirement / reinstatement is recorded. Required for any status write. */
  audit: Pick<AuditRepository, "append">;
  now?: () => Date;
}

function fleetAuditEntry(
  eventType: "worker.fleet.retired" | "worker.fleet.reinstated",
  at: string,
  details: Record<string, string>,
): AuditEntry {
  return {
    id: `${eventType.replace(/\./g, "-")}-${randomUUID()}`,
    occurredAt: at,
    eventType,
    actor: { ...FLEET_RECONCILER_ACTOR },
    details,
    createdAt: at,
  };
}

/**
 * Replays a plan through the canonical service.
 *
 * It writes DECLARATIONS, never a health or availability value. `register()` is a no-op
 * for an unchanged declaration, so `unchanged` is not written at all — that is what makes
 * calling this on every boot restart-safe instead of evidence-destroying.
 *
 * STATUS is written in exactly two governed cases, and only with an audit sink:
 *   retire    — `WorkerRegistrationService.retireFleetOrphan` (the DISABLE_WORKER effect
 *               plus a retirement marker), then a `worker.fleet.retired` audit entry;
 *   reinstate — `WorkerRegistrationService.reactivate` (the ENABLE_WORKER effect: evidence
 *               reset to never probed), the current declaration, then a
 *               `worker.fleet.reinstated` audit entry.
 * Both are idempotent across boots: a retired row is inactive and so no longer an orphan,
 * and a reinstated row is active and so no longer reinstatable. The store exposes no
 * transaction (0064), so the row is written first and the entry second; a failed audit
 * write throws and surfaces as WRITE_FAILED rather than passing silently.
 */
export async function applyComputeBootstrap(
  registration: WorkerRegistrationService,
  plan: ComputeBootstrapPlan,
  governance?: ComputeBootstrapGovernance,
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

  const retired: string[] = [];
  const reinstated: string[] = [];
  const skippedUnaudited: string[] = [];
  const now = governance?.now ?? (() => new Date());

  for (const orphan of plan.retire) {
    if (!governance) {
      skippedUnaudited.push(orphan.id);
      continue;
    }
    const after = await registration.retireFleetOrphan(orphan.id);
    if (!after) continue;
    retired.push(orphan.id);
    await governance.audit.append(
      fleetAuditEntry("worker.fleet.retired", now().toISOString(), {
        workerId: orphan.id,
        displayName: orphan.displayName,
        reason: FLEET_RETIREMENT_ORPHAN,
        source: plan.source,
        model: after.metadata.model ?? "",
        provider: after.metadata.provider ?? "",
        lastProbeOutcome: orphan.lastProbeOutcome,
        lastProbeErrorClass: orphan.lastProbeErrorClass ?? "",
      }),
    );
  }

  for (const planned of plan.reinstate) {
    if (!governance) {
      skippedUnaudited.push(planned.id);
      continue;
    }
    if (!(await registration.reactivate(planned.id))) continue;
    await registration.register(planned.declaration);
    reinstated.push(planned.id);
    await governance.audit.append(
      fleetAuditEntry("worker.fleet.reinstated", now().toISOString(), {
        workerId: planned.id,
        displayName: planned.declaration.displayName,
        reason: "LISTED_AGAIN",
        source: plan.source,
        model: planned.model,
        provider: planned.provider,
      }),
    );
  }

  return {
    registered,
    updated,
    unchanged: plan.unchanged.map((p) => p.id),
    skippedDisabled: plan.disabled.map((d) => d.id),
    retired,
    reinstated,
    skippedUnaudited,
    retirement: plan.retirement,
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
