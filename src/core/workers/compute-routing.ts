import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerFailureClass } from "@/core/contracts/worker-execution";

/**
 * GOVERNED COMPUTE ROUTING (decision 0054).
 *
 * The planner decides WHAT must be done. This module decides WHICH compute should do it — and
 * only ever as an ordering and a set of exclusions over candidates the canonical eligibility
 * authority (worker-eligibility.ts) has already found runnable. It is not a second router: the
 * CapabilityRouter calls the canonical matcher, and the matcher calls this.
 *
 * A COMPUTE CANDIDATE IS A REGISTERED WORKER. The registry already carries everything a
 * candidate needs to be governed — probe-dated health and availability, concurrency, a shared
 * capacity pool for a provider quota, and `metadata.model` / `metadata.provider`. What was
 * missing was (a) a model the executor actually runs (the `{{model}}` placeholder), (b) a
 * policy that prefers one candidate over another from facts, and (c) evidence of why.
 *
 * PURE: no I/O, no clock, no randomness. The clock, the history and the lease arrive as data,
 * so the same (registry rows, ledger rows, now, policy) always produces the same decision — the
 * property ROUTING_SURVIVES_RESTART (decision 0031) certified and this must not lose.
 *
 * UNKNOWN STAYS UNKNOWN. A candidate with no declared family has no tier; one with no history
 * has no rates. Neither is invented: an unknown tier is neither gated nor rewarded, and missing
 * history is replaced by an explicit, documented prior (cold start), never by zero or one.
 */

/** Bump when any value below changes meaning. Recorded on every routing decision. */
export const COMPUTE_POLICY_VERSION = "compute-routing/1";

export const MODEL_FAMILIES = [
  "NEMOTRON_120B",
  "NEMOTRON_550B",
  "GPT_SOL",
  "CLAUDE_SONNET",
  "CLAUDE_OPUS",
  "CLAUDE_HAIKU",
] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export interface FamilyHint {
  /**
   * 1..5: the hardest task class this family is a bootstrap FIT for. A PRIOR, not a ranking:
   * it only shapes `taskFit`, and measured history (reliability, review quality) carries more
   * combined weight than it does.
   */
  tier: number;
  /** 1..5 relative cost. A hint for cheap-first on easy work; never a hard gate. */
  costTier: number;
}

/**
 * Bootstrap role hints (owner-supplied, decision 0054). Policy INPUT, not truth:
 *   HAIKU        small bounded tasks, classification, extraction, low-risk inspection
 *   NEMOTRON_120 parallel bounded work, analysis, tests, routine implementation, cheap
 *   SONNET       general coding, local refactors, ordinary corrections
 *   SOL          difficult coding, debugging, architecture-sensitive, complex correction
 *   NEMOTRON_550 deep reasoning, long/complex tasks, alternative high-capability compute
 *   OPUS         difficult escalation, ambiguous/high-risk, repeated-rejection correction
 */
export const FAMILY_HINTS: Readonly<Record<ModelFamily, FamilyHint>> = Object.freeze({
  CLAUDE_HAIKU: { tier: 1, costTier: 1 },
  NEMOTRON_120B: { tier: 2, costTier: 1 },
  CLAUDE_SONNET: { tier: 3, costTier: 3 },
  GPT_SOL: { tier: 4, costTier: 4 },
  NEMOTRON_550B: { tier: 4, costTier: 2 },
  CLAUDE_OPUS: { tier: 5, costTier: 5 },
});

/**
 * How a provider's model id is recognised as a family. Matched in this order, first wins, so
 * the more specific Nemotron pattern precedes the general one. Data, not branching: no
 * provider name is compared anywhere else.
 */
export const FAMILY_PATTERNS: ReadonlyArray<readonly [ModelFamily, RegExp]> = [
  ["NEMOTRON_550B", /nemotron.*(550b|ultra)/i],
  ["NEMOTRON_120B", /nemotron.*(120b|super)/i],
  ["GPT_SOL", /gpt[-_.]?5[^/]*sol|(^|\/)sol([-_.]|$)/i],
  ["CLAUDE_OPUS", /opus/i],
  ["CLAUDE_SONNET", /sonnet/i],
  ["CLAUDE_HAIKU", /haiku/i],
];

export function inferModelFamily(modelId: string | undefined): ModelFamily | undefined {
  if (!modelId) return undefined;
  return FAMILY_PATTERNS.find(([, pattern]) => pattern.test(modelId))?.[0];
}

/**
 * Scoring weights. Each component is in [0, 1]; the score is the weighted sum minus the
 * penalties. Chosen so that measured behaviour (reliability + quality = 0.5) outweighs the
 * bootstrap prior (taskFit = 0.3): a family hint can start a candidate ahead, history can
 * overtake it.
 */
export const SCORE_WEIGHTS = Object.freeze({
  taskFit: 0.3,
  reliability: 0.25,
  quality: 0.25,
  cost: 0.1,
  /** Subtracted per unit of evidence that THIS model already failed THIS task. */
  priorFailureOnTask: 0.2,
  /** Subtracted per active execution, as a fraction of the candidate's concurrency. */
  load: 0.05,
});

/**
 * History treatment. Rates are Bayesian-smoothed toward a prior with pseudo-count K, so one
 * result moves a rate by at most 1/(n+K): no single timeout blacklists a model, no single
 * approval crowns one, and a model with no history scores exactly its prior (cold start).
 */
export const HISTORY_POLICY = Object.freeze({
  pseudoCount: 5,
  /** Prior probability an execution finishes without an infrastructure failure. */
  reliabilityPrior: 0.8,
  /** Prior probability a reviewed attempt is approved first time. */
  qualityPrior: 0.5,
  /** Only outcomes this recent count. */
  windowMs: 14 * 24 * 60 * 60_000,
  /** At most this many outcomes per model count (newest first). */
  maxOutcomesPerModel: 50,
});

/**
 * A provider/model that just refused us is excluded for a while rather than retried at once.
 * Keyed by provider for account-level refusals (rate limit, auth), by model for
 * MODEL_UNAVAILABLE. Exclusion, not a score penalty: re-sending into a known refusal is waste,
 * and a cooldown ends by itself.
 */
export const COOLDOWN_MS: Readonly<Partial<Record<WorkerFailureClass, number>>> = Object.freeze({
  RATE_LIMITED: 5 * 60_000,
  AUTH_FAILURE: 30 * 60_000,
  MODEL_UNAVAILABLE: 10 * 60_000,
});

/**
 * Time the ledger needs AFTER a worker's budget ends, inside the same lease: collect git
 * evidence, record the result, settle the attempt. A budget that leaves less than this before
 * the lease lapses gets its result fenced as stale (self-build run 3).
 */
export const SETTLEMENT_MARGIN_MS = 2 * 60_000;

/* ------------------------------------------------------------------------------------------ */
/* Candidate profile                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface ComputeProfile {
  /** `provider/model`, or `worker:<id>` when the worker reports no model. History key. */
  modelKey: string;
  provider?: string;
  model?: string;
  family?: ModelFamily;
  tier?: number;
  costTier?: number;
  contextWindow?: number;
  /** Per-candidate execution budget, if the registration declares one. */
  executionBudgetMs?: number;
  /** A larger budget this candidate may be given after a timeout, if declared. */
  maxExecutionBudgetMs?: number;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function modelKeyOf(worker: Pick<WorkerRegistryEntry, "id" | "metadata">): string {
  const { model, provider } = worker.metadata ?? {};
  return model ? `${provider ?? "unknown-provider"}/${model}` : `worker:${worker.id}`;
}

/** Reads a candidate's profile from its registration. Nothing is guessed but the family. */
export function computeProfileOf(worker: WorkerRegistryEntry): ComputeProfile {
  const metadata = worker.metadata ?? {};
  const declared = MODEL_FAMILIES.find((f) => f === metadata.modelFamily);
  const family = declared ?? inferModelFamily(metadata.model);
  const hint = family ? FAMILY_HINTS[family] : undefined;
  return {
    modelKey: modelKeyOf(worker),
    provider: metadata.provider,
    model: metadata.model,
    family,
    tier: hint?.tier,
    costTier: hint?.costTier,
    contextWindow: positiveInt(metadata.contextWindow),
    executionBudgetMs: positiveInt(metadata.executionBudgetMs),
    maxExecutionBudgetMs: positiveInt(metadata.maxExecutionBudgetMs),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Task requirement                                                                           */
/* ------------------------------------------------------------------------------------------ */

export type TaskComplexity = "low" | "medium" | "high";

/** What an earlier attempt of THIS task did, as the router needs to know it. */
export interface PriorAttemptFact {
  attempt: number;
  workerId?: string;
  modelKey?: string;
  failureClass?: WorkerFailureClass;
  /** The first independent review verdict on that attempt, if any. */
  reviewVerdict?: string;
}

/**
 * The normalized routing requirement. Built from the canonical Task and the attempt ledger by
 * the caller; it names capabilities and difficulty, NEVER a provider or model.
 */
export interface ComputeRequirement {
  role: "writer" | "reviewer";
  taskType?: string;
  complexity: TaskComplexity;
  risk?: "read_only" | "reversible" | "sensitive";
  repositoryMutation: boolean;
  /** Number of REQUEST_CHANGES this task has already received. */
  correctionAttempt: number;
  priorAttempts: readonly PriorAttemptFact[];
  /** Reviewer routing: the model that WROTE the work. Avoided when anything else qualifies. */
  writerModelKey?: string;
  /** Reviewer routing: the worker that wrote it. The router resolves its model. */
  writerWorkerId?: string;
  /** Execution budget used when a candidate declares none: its OWN runtime's timeout. */
  defaultBudgetMs?: (runtime: WorkerRegistryEntry["runtime"]) => number | undefined;
  /** The execution lease the budget must fit inside. Absent: the lease gate cannot run. */
  leaseMs?: number;
}

/** Complexity from the canonical Task's own fields when the planner did not state one. */
export function complexityFromRisk(risk: ComputeRequirement["risk"]): TaskComplexity {
  if (risk === "read_only") return "low";
  if (risk === "sensitive") return "high";
  return "medium";
}

const INFRA_TIMEOUT_OR_CRASH: ReadonlySet<WorkerFailureClass> = new Set([
  "EXECUTION_TIMEOUT",
  "WORKER_CRASHED",
  "STREAM_FAILED",
]);

/**
 * The tier this attempt should be served at, and why. Escalation is a function of facts on the
 * ledger: repeated legitimate rejection, or compute that did not finish.
 */
export function requiredTier(req: ComputeRequirement): { tier: number; reasons: string[] } {
  const reasons: string[] = [];
  let tier = req.complexity === "low" ? 1 : req.complexity === "high" ? 3 : 2;
  reasons.push(`complexity ${req.complexity} -> tier ${tier}`);

  if (req.correctionAttempt >= 2) {
    const bump = req.correctionAttempt >= 3 ? 2 : 1;
    tier += bump;
    reasons.push(`${req.correctionAttempt} legitimate reviewer rejections -> +${bump}`);
  }
  const last = [...req.priorAttempts].sort((a, b) => b.attempt - a.attempt)[0];
  if (last?.failureClass && INFRA_TIMEOUT_OR_CRASH.has(last.failureClass)) {
    tier += 1;
    reasons.push(`previous attempt ended ${last.failureClass} -> +1`);
  }
  return { tier: Math.min(5, tier), reasons };
}

/* ------------------------------------------------------------------------------------------ */
/* History                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** One terminal attempt, as read from the ledger. */
export interface ComputeOutcome {
  workerId: string;
  taskId: string;
  attempt: number;
  state: "completed" | "failed";
  failureClass?: WorkerFailureClass;
  reviewVerdict?: string;
  durationMs?: number;
  /** ISO instant the attempt settled. */
  at: string;
}

export interface ModelHistory {
  executions: number;
  infraFailures: number;
  timeouts: number;
  crashes: number;
  reviewed: number;
  firstPassApprovals: number;
  corrections: number;
  correctionApprovals: number;
  meanDurationMs?: number;
  /** Most recent refusal per cooldown class, ISO. */
  lastRefusalAt: Partial<Record<WorkerFailureClass, string>>;
}

const INFRA_FAILURES: ReadonlySet<WorkerFailureClass> = new Set([
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "STREAM_FAILED",
  "WORKER_CRASHED",
  "EXECUTION_TIMEOUT",
  "AUTH_FAILURE",
  "MODEL_UNAVAILABLE",
  "SESSION_EXHAUSTED",
]);

function emptyHistory(): ModelHistory {
  return {
    executions: 0,
    infraFailures: 0,
    timeouts: 0,
    crashes: 0,
    reviewed: 0,
    firstPassApprovals: 0,
    corrections: 0,
    correctionApprovals: 0,
    lastRefusalAt: {},
  };
}

/**
 * Aggregates ledger outcomes per model key, inside the window and the per-model cap. Outcomes
 * of workers the registry no longer knows are keyed `worker:<id>` and simply match nothing.
 */
export function aggregateHistory(
  outcomes: readonly ComputeOutcome[],
  modelKeyOfWorker: (workerId: string) => string,
  now: string,
): Map<string, ModelHistory> {
  const cutoff = Date.parse(now) - HISTORY_POLICY.windowMs;
  const byModel = new Map<string, ComputeOutcome[]>();
  for (const o of outcomes) {
    const at = Date.parse(o.at);
    if (Number.isNaN(at) || at < cutoff) continue;
    const key = modelKeyOfWorker(o.workerId);
    byModel.set(key, [...(byModel.get(key) ?? []), o]);
  }

  const result = new Map<string, ModelHistory>();
  for (const [key, list] of byModel) {
    const recent = [...list]
      .sort((a, b) => b.at.localeCompare(a.at) || a.taskId.localeCompare(b.taskId))
      .slice(0, HISTORY_POLICY.maxOutcomesPerModel);
    const h = emptyHistory();
    let durationSum = 0;
    let durationN = 0;
    for (const o of recent) {
      h.executions += 1;
      if (o.failureClass && INFRA_FAILURES.has(o.failureClass)) h.infraFailures += 1;
      if (o.failureClass === "EXECUTION_TIMEOUT") h.timeouts += 1;
      if (o.failureClass === "WORKER_CRASHED") h.crashes += 1;
      if (o.failureClass && COOLDOWN_MS[o.failureClass] !== undefined) {
        const prev = h.lastRefusalAt[o.failureClass];
        if (!prev || o.at > prev) h.lastRefusalAt[o.failureClass] = o.at;
      }
      /*
       * Review quality is judged only on work that FINISHED. A failed execution also gets a
       * verdict (RETRY), and counting it here would charge one infrastructure failure twice —
       * once to reliability, again to quality.
       */
      if (o.reviewVerdict && o.state === "completed") {
        h.reviewed += 1;
        const approved = o.reviewVerdict === "APPROVE";
        if (o.attempt === 1 && approved) h.firstPassApprovals += 1;
        if (o.attempt > 1) {
          h.corrections += 1;
          if (approved) h.correctionApprovals += 1;
        }
      }
      if (o.durationMs !== undefined) {
        durationSum += o.durationMs;
        durationN += 1;
      }
    }
    if (durationN > 0) h.meanDurationMs = Math.round(durationSum / durationN);
    result.set(key, h);
  }
  return result;
}

function smoothed(successes: number, n: number, prior: number): number {
  const k = HISTORY_POLICY.pseudoCount;
  return (successes + prior * k) / (n + k);
}

/* ------------------------------------------------------------------------------------------ */
/* Gates and score                                                                            */
/* ------------------------------------------------------------------------------------------ */

export type ComputeExclusion =
  /** Known tier more than one below what this attempt needs. */
  | "BELOW_REQUIRED_TIER"
  /** Its budget plus the settlement margin does not fit inside the execution lease. */
  | "BUDGET_EXCEEDS_LEASE"
  /** Its provider or model refused us recently (rate limit, auth, model unavailable). */
  | "PROVIDER_COOLDOWN"
  /** Reviewer routing: same model as the writer, while a different one qualifies. */
  | "SAME_MODEL_AS_WRITER";

export interface BudgetSelection {
  ms: number;
  source: "candidate-declared" | "escalated-after-timeout" | "runtime-default";
  reason: string;
}

/**
 * The budget this candidate would run with. After a timeout on this task the candidate's
 * declared larger budget is used — justified by the ledger, and still subject to the lease gate.
 */
export function selectBudget(
  profile: ComputeProfile,
  req: ComputeRequirement,
  runtime: WorkerRegistryEntry["runtime"],
): BudgetSelection | undefined {
  const timedOutBefore = req.priorAttempts.some((a) => a.failureClass === "EXECUTION_TIMEOUT");
  if (timedOutBefore && profile.maxExecutionBudgetMs) {
    return {
      ms: profile.maxExecutionBudgetMs,
      source: "escalated-after-timeout",
      reason: "a previous attempt of this task ended EXECUTION_TIMEOUT",
    };
  }
  if (profile.executionBudgetMs) {
    return { ms: profile.executionBudgetMs, source: "candidate-declared", reason: "registration" };
  }
  const runtimeDefault = req.defaultBudgetMs?.(runtime);
  if (runtimeDefault) {
    return { ms: runtimeDefault, source: "runtime-default", reason: `runtime ${runtime} command` };
  }
  return undefined;
}

/**
 * THE budget/lease invariant: budget + SETTLEMENT_MARGIN_MS <= lease. The lease is not renewed
 * while a worker runs, so a worker that uses its whole budget must still leave the settlement
 * margin before the lease lapses, or its result is fenced as stale and the work is lost.
 */
export function budgetFitsLease(budgetMs: number, leaseMs: number): boolean {
  return budgetMs + SETTLEMENT_MARGIN_MS <= leaseMs;
}

export interface ScoreBreakdown {
  taskFit: number;
  reliability: number;
  quality: number;
  cost: number;
  priorFailurePenalty: number;
  loadPenalty: number;
  total: number;
}

export interface ComputeVerdict {
  workerId: string;
  profile: ComputeProfile;
  exclusions: ComputeExclusion[];
  budget?: BudgetSelection;
  score?: ScoreBreakdown;
  history?: ModelHistory;
}

export interface ComputeContext {
  requirement: ComputeRequirement;
  history: ReadonlyMap<string, ModelHistory>;
  now: string;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

function isCoolingDown(h: ModelHistory | undefined, now: string): boolean {
  if (!h) return false;
  const t = Date.parse(now);
  return Object.entries(h.lastRefusalAt).some(([cls, at]) => {
    const window = COOLDOWN_MS[cls as WorkerFailureClass];
    return window !== undefined && at !== undefined && t - Date.parse(at) < window;
  });
}

/** Gates only. Scoring is separate so the reviewer rule can see who else qualifies. */
export function evaluateCompute(worker: WorkerRegistryEntry, ctx: ComputeContext): ComputeVerdict {
  const req = ctx.requirement;
  const profile = computeProfileOf(worker);
  const history = ctx.history.get(profile.modelKey);
  const exclusions: ComputeExclusion[] = [];

  const { tier: needed } = requiredTier(req);
  if (profile.tier !== undefined && profile.tier < needed - 1)
    exclusions.push("BELOW_REQUIRED_TIER");

  const budget = req.role === "writer" ? selectBudget(profile, req, worker.runtime) : undefined;
  if (budget && req.leaseMs !== undefined && !budgetFitsLease(budget.ms, req.leaseMs)) {
    exclusions.push("BUDGET_EXCEEDS_LEASE");
  }

  /*
   * Cooldown is shared across a provider for account-level refusals: every model behind a
   * throttled account is throttled. MODEL_UNAVAILABLE stays on the model's own history.
   */
  if (isCoolingDown(history, ctx.now)) exclusions.push("PROVIDER_COOLDOWN");
  else if (profile.provider) {
    for (const [key, h] of ctx.history) {
      if (!key.startsWith(`${profile.provider}/`) || key === profile.modelKey) continue;
      const account = { ...h, lastRefusalAt: { ...h.lastRefusalAt, MODEL_UNAVAILABLE: undefined } };
      if (isCoolingDown(account, ctx.now)) {
        exclusions.push("PROVIDER_COOLDOWN");
        break;
      }
    }
  }

  return { workerId: worker.id, profile, exclusions, budget, history };
}

export function scoreCompute(
  verdict: ComputeVerdict,
  ctx: ComputeContext,
  activeLoad: number,
  maxConcurrency: number,
): ScoreBreakdown {
  const req = ctx.requirement;
  const { profile, history } = verdict;
  const { tier: needed } = requiredTier(req);

  /* Under-provisioning costs more than over-provisioning; an unknown tier is neutral. */
  const taskFit =
    profile.tier === undefined
      ? 0.5
      : profile.tier < needed
        ? 1 - 0.5 * (needed - profile.tier)
        : 1 - 0.15 * (profile.tier - needed);

  const reliability = smoothed(
    (history?.executions ?? 0) - (history?.infraFailures ?? 0),
    history?.executions ?? 0,
    HISTORY_POLICY.reliabilityPrior,
  );
  /* A correction is judged on how corrections go; first attempts on first-pass acceptance. */
  const quality =
    req.correctionAttempt > 0
      ? smoothed(
          history?.correctionApprovals ?? 0,
          history?.corrections ?? 0,
          HISTORY_POLICY.qualityPrior,
        )
      : smoothed(
          history?.firstPassApprovals ?? 0,
          (history?.reviewed ?? 0) - (history?.corrections ?? 0),
          HISTORY_POLICY.qualityPrior,
        );

  /* Cheapness matters on easy work and fades on hard work. Unknown cost is neutral. */
  const cheapness = profile.costTier === undefined ? 0.5 : 1 - (profile.costTier - 1) / 4;
  const cost = cheapness * (1 - (needed - 1) / 4);

  /*
   * THIS task's own evidence against this model: a timeout or crash counts one, a legitimate
   * rejection counts a half. Different compute is preferred for the retry, not mandated —
   * if nothing else qualifies, the same model still can be chosen.
   */
  let evidence = 0;
  for (const prior of req.priorAttempts) {
    if (prior.modelKey !== profile.modelKey) continue;
    if (prior.failureClass && INFRA_FAILURES.has(prior.failureClass)) evidence += 1;
    if (prior.reviewVerdict === "REQUEST_CHANGES") evidence += 0.5;
  }
  const priorFailurePenalty = SCORE_WEIGHTS.priorFailureOnTask * Math.min(2, evidence);
  const loadPenalty = SCORE_WEIGHTS.load * (activeLoad / Math.max(1, maxConcurrency));

  const total =
    SCORE_WEIGHTS.taskFit * taskFit +
    SCORE_WEIGHTS.reliability * reliability +
    SCORE_WEIGHTS.quality * quality +
    SCORE_WEIGHTS.cost * cost -
    priorFailurePenalty -
    loadPenalty;

  return {
    taskFit: round(taskFit),
    reliability: round(reliability),
    quality: round(quality),
    cost: round(cost),
    priorFailurePenalty: round(priorFailurePenalty),
    loadPenalty: round(loadPenalty),
    total: round(total),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Normalized failure classes (owner's Phase 5 vocabulary)                                    */
/* ------------------------------------------------------------------------------------------ */

export type NormalizedFailure =
  | "TRANSIENT_PROVIDER_ERROR"
  | "RATE_LIMIT"
  | "AUTH_OR_CREDENTIAL_FAILURE"
  | "MODEL_UNAVAILABLE"
  | "EXECUTION_TIMEOUT"
  | "WORKER_CRASH"
  | "OWNERSHIP_LOST"
  | "LEASE_EXPIRED"
  | "TASK_LOGIC_FAILURE"
  | "REVIEW_REQUEST_CHANGES"
  | "REPOSITORY_GATE_FAILURE"
  | "UNKNOWN";

/**
 * ONE mapping from the ledger's operational classes (and the review/gate outcome) onto the
 * routing vocabulary. A review's REQUEST_CHANGES is never an infrastructure failure, and a
 * terminal task verdict is the task's, not the compute's.
 */
export function normalizeFailure(input: {
  failureClass?: WorkerFailureClass;
  reviewVerdict?: string;
  gateFailed?: boolean;
  ownershipLost?: boolean;
}): NormalizedFailure | undefined {
  if (input.ownershipLost) return "OWNERSHIP_LOST";
  switch (input.failureClass) {
    case "PROVIDER_UNAVAILABLE":
    case "STREAM_FAILED":
    case "SESSION_EXHAUSTED":
      return "TRANSIENT_PROVIDER_ERROR";
    case "RATE_LIMITED":
      return "RATE_LIMIT";
    case "AUTH_FAILURE":
      return "AUTH_OR_CREDENTIAL_FAILURE";
    case "MODEL_UNAVAILABLE":
      return "MODEL_UNAVAILABLE";
    case "EXECUTION_TIMEOUT":
      return "EXECUTION_TIMEOUT";
    case "WORKER_CRASHED":
      return "WORKER_CRASH";
    case "LEASE_EXPIRED":
      return "LEASE_EXPIRED";
    case "FAILED_TERMINAL":
      return "TASK_LOGIC_FAILURE";
    case "FAILED_RETRYABLE":
      return "UNKNOWN";
    case undefined:
      break;
  }
  if (input.reviewVerdict === "REQUEST_CHANGES") return "REVIEW_REQUEST_CHANGES";
  if (input.gateFailed) return "REPOSITORY_GATE_FAILURE";
  return undefined;
}
