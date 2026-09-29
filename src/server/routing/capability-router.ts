import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import {
  computeWorkerLoad,
  evaluateWorkerPool,
  isTransientRefusal,
  rankComputePool,
  selectWorker,
  HEALTH_EVIDENCE_MAX_AGE_MS,
  type ComputeCandidateVerdict,
  type WorkerEligibilityVerdict,
  type WorkerRequirement,
} from "@/core/workers/worker-eligibility";
import {
  aggregateHistory,
  modelKeyOf,
  requiredTier,
  COMPUTE_POLICY_VERSION,
  HISTORY_POLICY,
  SETTLEMENT_MARGIN_MS,
  type ComputeOutcome,
  type ComputeRequirement,
} from "@/core/workers/compute-routing";

/**
 * Capability routing (M4, mission N15, decision 0031).
 *
 * Turns `tasks.required_capabilities` — durable since migration 0041 but until
 * now consumed by nothing — into an actual worker selection.
 *
 * It owns NO matching logic of its own. Eligibility is entirely delegated to
 * the canonical authority in src/core/workers/worker-eligibility.ts, which is
 * also what IndependentReviewerSelector and BoundedRepairController use. One
 * question, one answer.
 *
 * M5: the router reads the DURABLE STORE directly, not a boot-time snapshot.
 * In M4 it consumed the hydrated `WorkerRegistryPort` read model, so a worker
 * registered or re-probed mid-process kept its stale eligibility until the next
 * container build — which meant a worker that had just gone unhealthy kept
 * receiving work. Reading the authority is both simpler and correct.
 *
 * M5.2: every decision carries a HEALTH EVIDENCE HORIZON. The router refuses a
 * worker whose probe evidence is missing or older than the horizon, so a
 * crashed worker stops receiving work at the moment of the decision rather than
 * whenever the next expiry sweep happens to run. The clock is injected, so the
 * decision stays a pure function of (durable rows, now) and remains
 * reproducible — a stored `now` replays to the same verdict.
 *
 * M5.3: each decision also carries a DURABLE LOAD SNAPSHOT, counted from the
 * dispatch ledger. That is what turns "first eligible by id" into real
 * distribution, and what lets a saturated worker be refused. Load is DERIVED,
 * never counted in memory: an in-memory round-robin cursor would distribute too,
 * and would silently break ROUTING_SURVIVES_RESTART (decision 0031) because a
 * fresh process would start the rotation over.
 *
 * THE ONE PERMISSIVE PATH, STATED PLAINLY
 * An EMPTY registry yields ROUTING_UNCONFIGURED and the caller dispatches as it
 * did before M4. This is not a fail-open matcher — it is the honest
 * "no routing table exists yet" state, and it is what keeps M4 reversible while
 * no deployment has registered workers. The moment ONE worker is registered the
 * registry becomes authoritative and routing fails closed: a task whose
 * capabilities nobody satisfies is refused, never dispatched to an arbitrary
 * worker.
 */
export type CapabilityRoutingDecision = "ROUTED" | "NO_ELIGIBLE_WORKER" | "ROUTING_UNCONFIGURED";

export interface CapabilityRoutingResult {
  decision: CapabilityRoutingDecision;
  /** Non-null only for ROUTED. */
  worker: WorkerRegistryEntry | null;
  requirement: WorkerRequirement;
  /**
   * Verdict for every candidate considered, ordered by worker id. This is the
   * durable "why" behind a refusal; a routing decision that cannot explain
   * itself is not evidence.
   */
  candidates: WorkerEligibilityVerdict[];
  reason: string;
  /**
   * ROUTING_DECISION evidence (decision 0054). Present whenever a compute requirement was
   * given — for a refusal as much as for a selection. Persisted with the attempt it created.
   */
  evidence?: RoutingDecisionEvidence;
  /**
   * NO_ELIGIBLE_WORKER only for reasons that end by themselves (cooldown, capacity). The caller
   * must treat it as back-pressure — leave the task ready — never block it (decision 0054).
   */
  transient?: boolean;
}

/** What the caller knows about the work. The router adds the lease and budget facts itself. */
export type ComputeRequest = Omit<ComputeRequirement, "leaseMs" | "defaultBudgetMs">;

export interface RoutingDecisionEvidence extends Record<string, unknown> {
  kind: "ROUTING_DECISION";
  policyVersion: string;
  decidedAt: string;
  role: ComputeRequirement["role"];
  requirement: {
    taskType?: string;
    complexity: ComputeRequirement["complexity"];
    risk?: ComputeRequirement["risk"];
    repositoryMutation: boolean;
    correctionAttempt: number;
    requiredCapabilities: readonly string[];
    writerModelKey?: string;
  };
  requiredTier: number;
  escalationReason: string[];
  previousFailure?: {
    attempt: number;
    failureClass?: string;
    reviewVerdict?: string;
    modelKey?: string;
  };
  candidateSet: Array<{
    workerId: string;
    provider?: string;
    model?: string;
    family?: string;
    tier?: number;
    selectable: boolean;
    fallback?: string;
    excludedBecause: string[];
    score?: Record<string, number>;
    budgetMs?: number;
    history?: { executions: number; infraFailures: number; timeouts: number; reviewed: number };
  }>;
  selected: {
    workerId: string;
    provider?: string;
    model?: string;
    family?: string;
    score?: number;
    /** False: the runtime does not pass `{{model}}`, so `model` is a label, not what ran. */
    modelSteered?: boolean;
  } | null;
  budget?: { ms: number; source: string; reason: string };
  lease?: { ms: number; settlementMarginMs: number };
}

export interface CapabilityRouterOptions {
  /** Injected clock. Kept out of the matcher so eligibility stays pure. */
  now?: () => Date;
  /** Health-evidence horizon. Defaults to the canonical one. */
  healthEvidenceMaxAgeMs?: number;
  /**
   * Durable worker assignments — one entry per active execution (M5.3).
   * Normally `dispatchAttempts.listActiveWorkerAssignments`. Absent means load
   * is unknown, ordering falls back to worker id, and the capacity gates do not
   * run: exactly the pre-M5.3 behaviour.
   */
  activeAssignments?: () => Promise<readonly string[]>;
  /**
   * Recent terminal attempts, for compute history (decision 0054). Normally
   * `dispatchAttempts.listRecentComputeOutcomes`. Absent: every candidate is cold-start.
   */
  computeHistory?: (since: Date) => Promise<readonly ComputeOutcome[]>;
  /** The execution lease a writer's budget must fit inside. Absent: the lease gate cannot run. */
  executionLeaseMs?: number;
  /**
   * Whether a runtime's launch command actually passes `{{model}}`. When it does not, the CLI's
   * default runs whatever the registration says — recorded, so history is never credited to a
   * label (decision 0054).
   */
  steersModel?: (runtime: WorkerRegistryEntry["runtime"]) => boolean;
  /** Budget for a candidate that declares none: ITS runtime's configured timeout. */
  defaultBudgetMs?: (runtime: WorkerRegistryEntry["runtime"]) => number | undefined;
}

export class CapabilityRouter {
  private readonly now: () => Date;
  private readonly healthEvidenceMaxAgeMs: number;
  private readonly activeAssignments?: () => Promise<readonly string[]>;
  private readonly options: CapabilityRouterOptions;

  constructor(
    private readonly workers: WorkerRegistryStore,
    options: CapabilityRouterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.healthEvidenceMaxAgeMs = options.healthEvidenceMaxAgeMs ?? HEALTH_EVIDENCE_MAX_AGE_MS;
    this.activeAssignments = options.activeAssignments;
    this.options = options;
  }

  async route(
    incoming: WorkerRequirement,
    compute?: ComputeRequest,
  ): Promise<CapabilityRoutingResult> {
    const pool = await this.workers.list();
    const now = this.now();

    /*
     * The horizon is imposed HERE, not trusted from the caller: a caller that
     * forgot it would silently route on undated health evidence. A caller may
     * still tighten it deliberately by passing its own.
     */
    const requirement: WorkerRequirement = {
      ...incoming,
      evidenceHorizon: incoming.evidenceHorizon ?? {
        now: now.toISOString(),
        maxAgeMs: this.healthEvidenceMaxAgeMs,
      },
      load:
        incoming.load ??
        (this.activeAssignments
          ? computeWorkerLoad(await this.activeAssignments(), pool)
          : undefined),
    };

    if (compute) {
      const outcomes = this.options.computeHistory
        ? await this.options.computeHistory(new Date(now.getTime() - HISTORY_POLICY.windowMs))
        : [];
      const keyOf = new Map(pool.map((w) => [w.id, modelKeyOf(w)] as const));
      requirement.compute = {
        requirement: {
          ...compute,
          /* Attribution is by worker on the ledger; the model a prior attempt ran is the registry's. */
          writerModelKey:
            compute.writerModelKey ??
            (compute.writerWorkerId ? keyOf.get(compute.writerWorkerId) : undefined),
          priorAttempts: compute.priorAttempts.map((p) => ({
            ...p,
            modelKey: p.modelKey ?? (p.workerId ? keyOf.get(p.workerId) : undefined),
          })),
          leaseMs: compute.role === "writer" ? this.options.executionLeaseMs : undefined,
          defaultBudgetMs: this.options.defaultBudgetMs,
        },
        history: aggregateHistory(
          outcomes,
          (id) => keyOf.get(id) ?? `worker:${id}`,
          now.toISOString(),
        ),
        now: now.toISOString(),
      };
    }

    if (pool.length === 0) {
      return {
        decision: "ROUTING_UNCONFIGURED",
        worker: null,
        requirement,
        candidates: [],
        reason: "Worker registry is empty: no routing table is configured.",
      };
    }

    const candidates = evaluateWorkerPool(pool, requirement);
    const worker = selectWorker(pool, requirement);
    const ranked = requirement.compute ? rankComputePool(pool, requirement) : undefined;
    const evidence = ranked ? buildEvidence(ranked, requirement, worker?.id ?? null) : undefined;
    if (evidence?.selected && worker && this.options.steersModel) {
      evidence.selected.modelSteered = this.options.steersModel(worker.runtime);
    }

    if (!worker) {
      return {
        decision: "NO_ELIGIBLE_WORKER",
        worker: null,
        requirement,
        candidates,
        evidence,
        transient: ranked ? isTransientRefusal(ranked) : false,
        reason: `No eligible worker among ${pool.length} registered for capabilities [${
          (requirement.requiredCapabilities ?? []).join(", ") || "none"
        }]${requirement.workerKind ? ` and workerKind ${requirement.workerKind}` : ""}.`,
      };
    }

    return {
      decision: "ROUTED",
      worker,
      requirement,
      candidates,
      evidence,
      reason: `Routed to worker ${worker.id} (${worker.workerKind})${
        requirement.load ? ` carrying ${requirement.load.byWorkerId[worker.id] ?? 0}` : ""
      }.`,
    };
  }
}

function buildEvidence(
  ranked: readonly ComputeCandidateVerdict[],
  requirement: WorkerRequirement,
  selectedId: string | null,
): RoutingDecisionEvidence {
  const ctx = requirement.compute!;
  const req = ctx.requirement;
  const tier = requiredTier(req);
  const chosen = ranked.find((v) => v.workerId === selectedId);
  const last = [...req.priorAttempts].sort((a, b) => b.attempt - a.attempt)[0];

  return {
    kind: "ROUTING_DECISION",
    policyVersion: COMPUTE_POLICY_VERSION,
    decidedAt: ctx.now,
    role: req.role,
    requirement: {
      taskType: req.taskType,
      complexity: req.complexity,
      risk: req.risk,
      repositoryMutation: req.repositoryMutation,
      correctionAttempt: req.correctionAttempt,
      requiredCapabilities: requirement.requiredCapabilities ?? [],
      writerModelKey: req.writerModelKey,
    },
    requiredTier: tier.tier,
    escalationReason: tier.reasons,
    previousFailure: last
      ? {
          attempt: last.attempt,
          failureClass: last.failureClass,
          reviewVerdict: last.reviewVerdict,
          modelKey: last.modelKey,
        }
      : undefined,
    candidateSet: ranked.map((v) => ({
      workerId: v.workerId,
      provider: v.profile.provider,
      model: v.profile.model,
      family: v.profile.family,
      tier: v.profile.tier,
      selectable: v.selectable,
      fallback: v.fallback,
      excludedBecause: [...v.eligibility.reasons, ...v.exclusions],
      score: v.score ? { ...v.score } : undefined,
      budgetMs: v.budget?.ms,
      history: v.history
        ? {
            executions: v.history.executions,
            infraFailures: v.history.infraFailures,
            timeouts: v.history.timeouts,
            reviewed: v.history.reviewed,
          }
        : undefined,
    })),
    selected: chosen
      ? {
          workerId: chosen.workerId,
          provider: chosen.profile.provider,
          model: chosen.profile.model,
          family: chosen.profile.family,
          score: chosen.score?.total,
        }
      : null,
    budget: chosen?.budget ? { ...chosen.budget } : undefined,
    lease:
      req.leaseMs !== undefined
        ? { ms: req.leaseMs, settlementMarginMs: SETTLEMENT_MARGIN_MS }
        : undefined,
  };
}
