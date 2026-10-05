import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import {
  ICOS_PRICE_REGISTRY,
  costMicros,
  resolvePrice,
  type PriceRegistry,
} from "@/core/pricing/registry";

import {
  COMPUTE_POLICY_VERSION,
  effectiveModelKey,
  sameEffectiveModel,
  SETTLEMENT_MARGIN_MS,
  type ComputeContext,
} from "./compute-routing";
import {
  TRANSIENT_EXCLUSIONS,
  rankComputePool,
  type ComputeCandidateVerdict,
  type WorkerRequirement,
} from "./worker-eligibility";

/**
 * GOVERNED INFERENCE PLANS (decision 0071).
 *
 * OmniRoute stays the ONLY routing authority. This module adds no second router and no second
 * registry: every candidate it names comes out of `rankComputePool` — the canonical matcher plus
 * decision 0054's compute policy — and nothing it does can make a candidate that authority
 * refused become selectable.
 *
 * What was missing is not selection, it is SHAPE. Before this module the system could answer
 * "which compute should do this?" exactly once per dispatch. It could not state, durably and in
 * advance, "try the cheap tier, escalate on failure, then have an independent model review it,
 * and stop at these ceilings". Fallback existed only as whatever the next dispatch pass happened
 * to choose — a decision with no record and no declared bound.
 *
 * A PLAN SELECTS AND USES MODELS. IT DOES NOT ORCHESTRATE. It is data: a serializable, ordered
 * list of stages, each naming its role, its ordered candidates, what makes it hand over, and the
 * ceilings it must respect. Whoever executes it — CORE3's supervisor, QC, the reviewer service —
 * keeps every authority it already has. Brain != Worker != Model != Provider: a stage names a
 * WORKER (which carries a model and a provider); it never names a brain and never becomes one.
 *
 * PURE: no I/O, no clock, no randomness. The clock arrives inside `ComputeContext.now`, prices
 * arrive as a registry argument. Same inputs -> same plan, so a plan read back from the database
 * can be re-derived and checked.
 *
 * FOUR THINGS A CALLER CANNOT DO, BY CONSTRUCTION:
 *  1. NAME A PROVIDER OR A MODEL. `InferencePlanRequest` has no such field. Privileged-provider
 *     bypass is not refused at runtime, it is unexpressible.
 *  2. WIDEN A CEILING. `requested` is narrowed against `governed` (see effectiveCeilings): every
 *     numeric ceiling takes the MINIMUM, every enforcement flag takes the OR. The Goal budget and
 *     the policy remain authoritative; a caller may only tighten.
 *  3. GET A SILENT FALLBACK. An alternate is a candidate inside a declared stage, or a declared
 *     later stage. Nothing outside the plan is a route.
 *  4. GET AN UNPROVABLE COST PAST A MONEY CEILING. Money enforcement with an unknown price, or
 *     with no token ceiling to bound the worst case, refuses — it never estimates.
 */

/** Bump when the shape or the meaning of a plan changes. Recorded on every plan. */
export const INFERENCE_PLAN_VERSION = "inference-plan/1";

export const INFERENCE_TOPOLOGIES = [
  /** One stage, one candidate. No alternate: a failure is the task's failure. */
  "single",
  /** One stage, ordered alternates. The next candidate runs only on a declared failure. */
  "fallback",
  /** One writer stage per ascending KNOWN tier. Escalates on failure or rejection. */
  "cascade",
  /** Produce, then an independent critique, then a revision by a writer. */
  "critique",
  /** Produce, then an independent review. The reviewer never mutates the repository. */
  "reviewer",
  /** Several diverse writers in parallel, then one independent aggregation. */
  "ensemble",
  /** Cascade ordered by ascending KNOWN cost tier instead of capability tier. */
  "cheap-first-escalate",
  /** One stage, candidates ordered by MEASURED mean duration (unmeasured last). */
  "latency-first",
  /** One stage, candidates ordered by MEASURED review quality (unmeasured last). */
  "quality-first",
  /** The caller declares the role/purpose sequence. Still gated, still ceiling-bound. */
  "mission-specific",
] as const;
export type InferenceTopology = (typeof INFERENCE_TOPOLOGIES)[number];

/** A stage's role is the ROUTER's role. No third role is invented. */
export type StageRole = "writer" | "reviewer";

export type StagePurpose =
  | "produce"
  | "escalate"
  | "critique"
  | "revise"
  | "review"
  | "member"
  | "aggregate";

/** What hands a stage over to the next one, or ends the plan. Declared, never inferred at run time. */
export const ADVANCE_CONDITIONS = [
  "STAGE_COMPLETED",
  "STAGE_FAILED",
  "STAGE_TIMED_OUT",
  "REVIEW_REQUEST_CHANGES",
  "ALL_MEMBERS_SETTLED",
] as const;
export type AdvanceCondition = (typeof ADVANCE_CONDITIONS)[number];

export const TERMINATION_CONDITIONS = [
  "FINAL_STAGE_COMPLETED",
  "REVIEW_APPROVED",
  "CANDIDATES_EXHAUSTED",
  "RETRY_BUDGET_EXHAUSTED",
  "CEILING_REACHED",
  "REVIEW_BLOCKED",
] as const;
export type TerminationCondition = (typeof TERMINATION_CONDITIONS)[number];

/**
 * Every field is a MAXIMUM, and every maximum is optional — ICOS does not invent a ceiling it was
 * not given. The two enforcement flags say what an UNKNOWN means: with the flag set, a candidate
 * whose value cannot be proven is refused; without it, unknown stays unknown and is not gated.
 */
export interface PlanCeilings {
  /** Measured mean duration a candidate may not exceed. */
  latencyMs?: number;
  /** Output tokens a stage may be given. Also the worst case the money ceiling is proven against. */
  tokens?: number;
  /** Integer micros of {@link import("@/core/budget/contracts").BudgetCurrency}, per stage. */
  moneyMicros?: number;
  /** True: an unprovable cost is a refusal. The money ceiling then fails CLOSED. */
  moneyEnforced?: boolean;
  /** True: an unmeasured latency is a refusal. */
  latencyEnforced?: boolean;
}

export type CeilingSource = "governed" | "requested" | "unset";

export interface InferencePlanRequest {
  topology: InferenceTopology;
  /**
   * The AUTHORITY's ceilings — the Goal budget, the policy, the lease. Not the caller's wish.
   * Whatever is absent here cannot be introduced by `requested`.
   */
  governed: PlanCeilings;
  /** The caller's wish. NARROWING ONLY: see effectiveCeilings. */
  requested?: PlanCeilings;
  /**
   * `required`: a judge sharing the writer's effective model is a refusal, not a preference.
   * `preferred`: decision 0054's existing behaviour (avoided while anything else qualifies).
   * Defaults to `required` for `reviewer` and `critique`, which exist to be independent.
   */
  independence?: "required" | "preferred";
  /** How candidates in one stage must differ. `ensemble` defaults to `family`. */
  diversity?: "none" | "model" | "family";
  /** Alternates per stage (`fallback`, `latency-first`, `quality-first`) or members (`ensemble`). */
  width?: number;
  /** Attempts a stage may spend across its candidates before the plan terminates. */
  maxAttemptsPerStage?: number;
  /** `mission-specific` only. Roles and purposes — never models. */
  stages?: ReadonlyArray<{ role: StageRole; purpose: StagePurpose }>;
  /** A stage must have a candidate declaring tool support. */
  requiresTools?: boolean;
  /** A stage must have a candidate declaring structured output. */
  requiresStructuredOutput?: boolean;
}

/** Gates this module adds on top of the router's. Recorded per candidate, never silent. */
export type PlanExclusion =
  /** Measured mean duration exceeds the latency ceiling. */
  | "LATENCY_CEILING_EXCEEDED"
  /** Latency is enforced and this candidate has no measured duration. */
  | "LATENCY_UNMEASURED"
  /** Its declared context window cannot hold the token ceiling. */
  | "CONTEXT_BELOW_TOKEN_CEILING"
  /** Money is enforced and this candidate's price is unknown, stale or ambiguous. */
  | "COST_UNPROVABLE"
  /** Its worst-case cost at the token ceiling exceeds the money ceiling. */
  | "MONEY_CEILING_EXCEEDED"
  /** Declares no tool support while the plan requires it. */
  | "TOOLS_UNSUPPORTED"
  /** Declares no structured output while the plan requires it. */
  | "STRUCTURED_OUTPUT_UNSUPPORTED"
  /** Diversity: an earlier candidate in this stage already represents its model. */
  | "DUPLICATE_MODEL"
  /** Diversity: an earlier candidate in this stage already represents its family. */
  | "DUPLICATE_FAMILY"
  /** Independence is required and this candidate is the same judge as the writer. */
  | "NOT_INDEPENDENT_OF_WRITER";

export interface PlannedCandidate {
  workerId: string;
  provider?: string;
  model?: string;
  family?: string;
  tier?: number;
  costTier?: number;
  /** The router's own score. Ordering inside a stage is the router's unless the topology reorders. */
  score?: number;
  budgetMs?: number;
  /** Measured, from the ledger. Absent = never measured; never estimated. */
  meanDurationMs?: number;
  /** The router's smoothed review-quality rate for this model. What `quality-first` orders on. */
  qualityScore?: number;
  /** The router's smoothed infrastructure-reliability rate for this model. */
  reliabilityScore?: number;
  /**
   * Worst case at the plan's token ceiling, in integer micros. Absent means NOT PROVEN — either
   * no price, or no token ceiling to bound it. Absent is never read as cheap.
   */
  worstCaseCostMicros?: number;
  /** Why the cost is not proven. Present exactly when `worstCaseCostMicros` is absent. */
  costUnprovableBecause?: string;
}

/**
 * Why one candidate is not in the plan. `because` is labels only, so a consumer can branch on
 * them; `costUnprovableBecause` carries the registry's own words, because "the price is unknown"
 * and "the price is STALE since 2026-02-01" are different operational problems and a refusal that
 * cannot tell them apart sends an operator to the wrong place.
 */
export interface RefusedCandidate {
  workerId: string;
  because: readonly string[];
  costUnprovableBecause?: string;
}

export interface PlannedStage {
  index: number;
  role: StageRole;
  purpose: StagePurpose;
  /** How many candidates of this stage run at once. 1 everywhere but an `ensemble` member stage. */
  parallelism: number;
  /** Ordered. The first runs; a later one runs only on a condition in `advanceWhen`. */
  candidates: readonly PlannedCandidate[];
  /** Attempts this stage may spend across its candidates. */
  maxAttempts: number;
  /** What hands over to the next stage — or, on the last stage, ends the plan. */
  advanceWhen: readonly AdvanceCondition[];
  /** Hard refusals this stage inherited: the workers it may not use (independence, burnt retry). */
  excludedWorkerIds: readonly string[];
  budgetMs?: number;
  tokenCeiling?: number;
  moneyCeilingMicros?: number;
  /** Every candidate the router or this module refused, with the reasons. Durable "why not". */
  refused: readonly RefusedCandidate[];
}

export interface InferencePlan {
  kind: "INFERENCE_PLAN";
  planVersion: string;
  /** The ROUTER's policy version. A plan is only as valid as the policy that ranked it. */
  policyVersion: string;
  plannedAt: string;
  topology: InferenceTopology;
  /** The EFFECTIVE ceilings: governed, narrowed by requested. */
  ceilings: PlanCeilings;
  /** Which side each ceiling came from. The evidence that nothing was widened. */
  ceilingSources: Readonly<Record<keyof PlanCeilings, CeilingSource>>;
  independence: "required" | "preferred";
  diversity: "none" | "model" | "family";
  stages: readonly PlannedStage[];
  terminateWhen: readonly TerminationCondition[];
  /** Telemetry a run of this plan must produce. A stage with no evidence is an unproven stage. */
  evidenceRequired: readonly string[];
}

export interface NoViableRoute {
  kind: "NO_VIABLE_ROUTE";
  planVersion: string;
  plannedAt: string;
  topology: InferenceTopology;
  /** The stage that could not be filled. */
  atStage: number;
  role: StageRole;
  purpose: StagePurpose;
  reason: string;
  refused: readonly RefusedCandidate[];
  /**
   * True when EVERY refusal ends by itself (cooldown, capacity). The caller must then apply
   * back-pressure — leave the work ready — exactly as decision 0054's `transient` requires.
   */
  transient: boolean;
}

export type InferencePlanOutcome = InferencePlan | NoViableRoute;

/** A base requirement that already carries a compute context: the router's own input. */
export type PlanBase = WorkerRequirement & { compute: ComputeContext };

/* ------------------------------------------------------------------------------------------ */
/* Ceilings: narrowing only                                                                   */
/* ------------------------------------------------------------------------------------------ */

const CEILING_KEYS = [
  "latencyMs",
  "tokens",
  "moneyMicros",
  "moneyEnforced",
  "latencyEnforced",
] as const;

/**
 * THE anti-widening rule. A numeric ceiling takes the MINIMUM of the two sides, and a side that
 * did not state one cannot introduce one the authority left out — so a caller asking for more
 * tokens than the Goal allows gets the Goal's number, and a caller asking for a money ceiling
 * where the authority set none gets its own (tighter) one. An enforcement flag takes the OR: a
 * caller can turn fail-closed ON, never off.
 */
export function effectiveCeilings(
  governed: PlanCeilings,
  requested: PlanCeilings = {},
): { ceilings: PlanCeilings; sources: Record<keyof PlanCeilings, CeilingSource> } {
  const ceilings: PlanCeilings = {};
  const sources = {} as Record<keyof PlanCeilings, CeilingSource>;

  for (const key of CEILING_KEYS) {
    if (key === "moneyEnforced" || key === "latencyEnforced") {
      const g = governed[key] === true;
      const r = requested[key] === true;
      ceilings[key] = g || r;
      sources[key] = g ? "governed" : r ? "requested" : "unset";
      continue;
    }
    const g = governed[key];
    const r = requested[key];
    if (g === undefined && r === undefined) {
      sources[key] = "unset";
      continue;
    }
    if (g === undefined) {
      ceilings[key] = r;
      sources[key] = "requested";
      continue;
    }
    if (r === undefined || r >= g) {
      ceilings[key] = g;
      sources[key] = "governed";
      continue;
    }
    ceilings[key] = r;
    sources[key] = "requested";
  }

  return { ceilings, sources };
}

/* ------------------------------------------------------------------------------------------ */
/* Per-candidate admission under the plan's ceilings                                          */
/* ------------------------------------------------------------------------------------------ */

interface Admitted {
  candidate: PlannedCandidate;
  exclusions: PlanExclusion[];
}

/**
 * The worst a stage can cost: the whole token ceiling billed at the COMPLETION rate, which is
 * never below the prompt rate. Overestimating is the only safe direction under a cap, and the
 * registry's integer-micros arithmetic already rounds a non-zero remainder UP.
 */
function worstCaseCost(
  model: string | undefined,
  tokens: number | undefined,
  prices: PriceRegistry,
  now: Date,
): { micros: number } | { unprovable: string } {
  if (model === undefined) return { unprovable: "le candidat ne déclare aucun modèle" };
  if (tokens === undefined) {
    return { unprovable: "aucun plafond de tokens : le pire cas n'est pas borné" };
  }
  const resolved = resolvePrice(prices, model, now);
  if (resolved.kind !== "PRICE") return { unprovable: `${resolved.defect}: ${resolved.reason}` };
  const cost = costMicros(resolved.record, {
    promptTokens: 0,
    completionTokens: tokens,
    totalTokens: tokens,
  });
  if (cost.kind !== "COST_MICROS") return { unprovable: `${cost.defect}: ${cost.reason}` };
  return { micros: cost.micros };
}

function admit(
  verdict: ComputeCandidateVerdict,
  worker: WorkerRegistryEntry,
  ceilings: PlanCeilings,
  request: InferencePlanRequest,
  prices: PriceRegistry,
  now: Date,
): Admitted {
  const { profile, history } = verdict;
  const exclusions: PlanExclusion[] = [];
  const meanDurationMs = history?.meanDurationMs;

  if (ceilings.latencyMs !== undefined) {
    if (meanDurationMs === undefined) {
      /* Unknown stays unknown unless the authority asked for fail-closed latency. */
      if (ceilings.latencyEnforced) exclusions.push("LATENCY_UNMEASURED");
    } else if (meanDurationMs > ceilings.latencyMs) {
      exclusions.push("LATENCY_CEILING_EXCEEDED");
    }
  } else if (ceilings.latencyEnforced && meanDurationMs === undefined) {
    exclusions.push("LATENCY_UNMEASURED");
  }

  if (
    ceilings.tokens !== undefined &&
    profile.contextWindow !== undefined &&
    profile.contextWindow < ceilings.tokens
  ) {
    exclusions.push("CONTEXT_BELOW_TOKEN_CEILING");
  }

  const cost = worstCaseCost(profile.model, ceilings.tokens, prices, now);
  if ("micros" in cost) {
    if (ceilings.moneyMicros !== undefined && cost.micros > ceilings.moneyMicros) {
      exclusions.push("MONEY_CEILING_EXCEEDED");
    }
  } else if (ceilings.moneyEnforced) {
    /* FAIL CLOSED. A cost nobody can prove is not a cost that fits. */
    exclusions.push("COST_UNPROVABLE");
  }

  /*
   * The budget/lease invariant is NOT re-decided here: the router already gates it per candidate
   * (BUDGET_EXCEEDS_LEASE, decision 0054) with the lease the container actually takes, and a
   * second opinion from a module that does not hold the lease would be a second authority.
   */
  const budgetMs = verdict.budget?.ms;

  if (request.requiresTools && !worker.supportsTools) exclusions.push("TOOLS_UNSUPPORTED");
  if (request.requiresStructuredOutput && !worker.supportsStructuredOutput) {
    exclusions.push("STRUCTURED_OUTPUT_UNSUPPORTED");
  }

  return {
    exclusions,
    candidate: {
      workerId: verdict.workerId,
      provider: profile.provider,
      model: profile.model,
      family: profile.family,
      tier: profile.tier,
      costTier: profile.costTier,
      score: verdict.score?.total,
      qualityScore: verdict.score?.quality,
      reliabilityScore: verdict.score?.reliability,
      budgetMs,
      meanDurationMs,
      ...("micros" in cost
        ? { worstCaseCostMicros: cost.micros }
        : { costUnprovableBecause: cost.unprovable }),
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Topology shape                                                                             */
/* ------------------------------------------------------------------------------------------ */

interface StageShape {
  role: StageRole;
  purpose: StagePurpose;
  advanceWhen: readonly AdvanceCondition[];
  parallelism: number;
  /** Candidates to keep in this stage. `undefined` = one per ascending group (cascade). */
  width: number;
}

const DEFAULT_WIDTH = 2;
const MAX_WIDTH = 8;

function clampWidth(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isSafeInteger(requested) || requested < 1) return fallback;
  return Math.min(MAX_WIDTH, requested);
}

/**
 * The ordered shape of a topology. The only place stage counts and hand-over conditions are
 * decided; everything after this is filling stages from the router's ranking.
 *
 * `cascade` and `cheap-first-escalate` return a single template: their stage COUNT is not known
 * until the ranked pool is grouped, because a cascade escalates through the tiers the fleet
 * actually has — never through tiers invented for the plan.
 */
function shapeOf(request: InferencePlanRequest): { stages: StageShape[]; grouped: boolean } {
  const width = clampWidth(request.width, DEFAULT_WIDTH);
  const produce = (purpose: StagePurpose, w: number, advance: readonly AdvanceCondition[]) =>
    ({ role: "writer" as const, purpose, advanceWhen: advance, parallelism: 1, width: w });
  const judge = (purpose: StagePurpose, advance: readonly AdvanceCondition[]) =>
    ({ role: "reviewer" as const, purpose, advanceWhen: advance, parallelism: 1, width: 1 });

  switch (request.topology) {
    case "single":
      return { stages: [produce("produce", 1, ["STAGE_COMPLETED"])], grouped: false };
    case "fallback":
    case "latency-first":
    case "quality-first":
      return {
        stages: [produce("produce", width, ["STAGE_COMPLETED"])],
        grouped: false,
      };
    case "cascade":
    case "cheap-first-escalate":
      return {
        stages: [produce("produce", 1, ["STAGE_FAILED", "STAGE_TIMED_OUT", "REVIEW_REQUEST_CHANGES"])],
        grouped: true,
      };
    case "reviewer":
      return {
        stages: [produce("produce", width, ["STAGE_COMPLETED"]), judge("review", ["STAGE_COMPLETED"])],
        grouped: false,
      };
    case "critique":
      return {
        stages: [
          produce("produce", width, ["STAGE_COMPLETED"]),
          judge("critique", ["STAGE_COMPLETED"]),
          produce("revise", 1, ["STAGE_COMPLETED"]),
        ],
        grouped: false,
      };
    case "ensemble":
      return {
        stages: [
          {
            role: "writer",
            purpose: "member",
            advanceWhen: ["ALL_MEMBERS_SETTLED"],
            parallelism: Math.max(2, width),
            width: Math.max(2, width),
          },
          judge("aggregate", ["STAGE_COMPLETED"]),
        ],
        grouped: false,
      };
    case "mission-specific":
      return {
        stages: (request.stages ?? []).map((s) => ({
          role: s.role,
          purpose: s.purpose,
          advanceWhen: ["STAGE_COMPLETED"],
          parallelism: 1,
          width: s.role === "reviewer" ? 1 : width,
        })),
        grouped: false,
      };
  }
}

/**
 * Candidate ordering INSIDE a stage. The router's score is the default; three topologies reorder
 * on a MEASURED fact, and an unmeasured candidate always sorts last rather than being guessed at.
 */
function reorder(
  topology: InferenceTopology,
  admitted: readonly Admitted[],
): readonly Admitted[] {
  const byMeasure = (value: (a: Admitted) => number | undefined, better: "low" | "high") =>
    [...admitted].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === undefined && vb === undefined) return 0;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      return better === "low" ? va - vb : vb - va;
    });

  switch (topology) {
    case "latency-first":
      return byMeasure((a) => a.candidate.meanDurationMs, "low");
    case "quality-first":
      /* The measured review-quality rate, not the aggregate score: a cheap, fast, poorly
         reviewed model must not win a quality-first stage on its cost component. */
      return byMeasure((a) => a.candidate.qualityScore, "high");
    case "cheap-first-escalate":
      return byMeasure((a) => a.candidate.costTier, "low");
    default:
      return admitted;
  }
}

/** Diversity, applied in order so the strongest candidate always keeps its place. */
function applyDiversity(
  admitted: readonly Admitted[],
  diversity: "none" | "model" | "family",
): Admitted[] {
  if (diversity === "none") return [...admitted];
  const seen = new Set<string>();
  return admitted.map((a) => {
    if (a.exclusions.length > 0) return a;
    const key =
      diversity === "family"
        ? (a.candidate.family ?? `model:${a.candidate.model ?? a.candidate.workerId}`)
        : a.candidate.model !== undefined
          ? effectiveModelKey(a.candidate.model)
          : `worker:${a.candidate.workerId}`;
    if (seen.has(key)) {
      return {
        ...a,
        exclusions: [...a.exclusions, diversity === "family" ? "DUPLICATE_FAMILY" : "DUPLICATE_MODEL"],
      };
    }
    seen.add(key);
    return a;
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Planning                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const JUDGE_PURPOSES: ReadonlySet<StagePurpose> = new Set(["review", "critique", "aggregate"]);

const DEFAULT_MAX_ATTEMPTS = 2;

const EVIDENCE_REQUIRED = Object.freeze([
  /* Per STAGE, not per plan: a plan whose cost is known only in total cannot attribute it. */
  "ROUTING_DECISION per stage",
  "tokenUsage per stage (UNMETERED when unreadable, never 0)",
  "costMicros per stage when the price is known, UNPRICED otherwise",
  "executionDurationMs per stage",
  "stage outcome and the AdvanceCondition that fired",
]);

/**
 * Builds a governed plan, or refuses with a durable reason.
 *
 * Every candidate comes from `rankComputePool(pool, requirement)` — one call per stage, with the
 * stage's role and its inherited hard exclusions. This module never promotes a candidate the
 * router refused: `admit` can only ADD exclusions.
 */
export function planInference(
  pool: readonly WorkerRegistryEntry[],
  base: PlanBase,
  request: InferencePlanRequest,
  prices: PriceRegistry = ICOS_PRICE_REGISTRY,
): InferencePlanOutcome {
  const plannedAt = base.compute.now;
  const now = new Date(plannedAt);
  const { ceilings, sources } = effectiveCeilings(request.governed, request.requested);
  const independence =
    request.independence ??
    (request.topology === "reviewer" || request.topology === "critique" ? "required" : "preferred");
  const diversity = request.diversity ?? (request.topology === "ensemble" ? "family" : "none");
  const maxAttempts = clampWidth(request.maxAttemptsPerStage, DEFAULT_MAX_ATTEMPTS);
  const shape = shapeOf(request);
  const byId = new Map(pool.map((w) => [w.id, w] as const));

  if (shape.stages.length === 0) {
    return {
      kind: "NO_VIABLE_ROUTE",
      planVersion: INFERENCE_PLAN_VERSION,
      plannedAt,
      topology: request.topology,
      atStage: 0,
      role: "writer",
      purpose: "produce",
      reason: "topology mission-specific sans étape déclarée",
      refused: [],
      transient: false,
    };
  }

  const stages: PlannedStage[] = [];
  /** Workers already used by a producing stage: a judge may never be one of them. */
  const writerWorkerIds: string[] = [];
  /** The model of the work a judge will judge, when it is known. */
  let writerModel: string | undefined;

  for (const [index, template] of shape.stages.entries()) {
    const judging = JUDGE_PURPOSES.has(template.purpose);
    const excludedWorkerIds = judging ? [...new Set(writerWorkerIds)] : [];

    const requirement: WorkerRequirement = {
      ...base,
      excludeWorkerIds: [...(base.excludeWorkerIds ?? []), ...excludedWorkerIds],
      compute: {
        ...base.compute,
        requirement: {
          ...base.compute.requirement,
          role: template.role,
          ...(judging ? { writerModelKey: writerModel } : {}),
        },
      },
    };

    const ranked = rankComputePool(pool, requirement);
    const scored = ranked.map((v) =>
      admit(v, byId.get(v.workerId)!, ceilings, request, prices, now),
    );

    /*
     * INDEPENDENCE AS A REFUSAL. The router avoids the writer's model while anything else
     * qualifies, then relaxes so work never stalls on a preference. For a plan that DECLARED
     * independence as required, relaxing is not acceptable: the stage refuses instead.
     */
    const withIndependence =
      judging && independence === "required" && writerModel !== undefined
        ? scored.map((a) =>
            a.candidate.model !== undefined && sameEffectiveModel(a.candidate.model, writerModel!)
              ? { ...a, exclusions: [...a.exclusions, "NOT_INDEPENDENT_OF_WRITER" as PlanExclusion] }
              : a,
          )
        : scored;

    const routerRefusal = new Map(
      ranked.map((v) => [v.workerId, [...v.eligibility.reasons, ...v.exclusions]] as const),
    );
    const ordered = reorder(request.topology, withIndependence);
    const diverse = applyDiversity(ordered, judging ? "none" : diversity);

    const viable = diverse.filter(
      (a) => a.exclusions.length === 0 && (routerRefusal.get(a.candidate.workerId)?.length ?? 0) === 0,
    );
    const refused: RefusedCandidate[] = diverse
      .filter((a) => !viable.includes(a))
      .map((a) => ({
        workerId: a.candidate.workerId,
        because: [...(routerRefusal.get(a.candidate.workerId) ?? []), ...a.exclusions],
        ...(a.candidate.costUnprovableBecause !== undefined
          ? { costUnprovableBecause: a.candidate.costUnprovableBecause }
          : {}),
      }));

    if (viable.length === 0) {
      const all = refused.flatMap((r) => r.because);
      return {
        kind: "NO_VIABLE_ROUTE",
        planVersion: INFERENCE_PLAN_VERSION,
        plannedAt,
        topology: request.topology,
        atStage: index,
        role: template.role,
        purpose: template.purpose,
        reason:
          refused.length === 0
            ? `aucun worker enregistré pour l'étape ${template.purpose}`
            : `aucun candidat viable pour l'étape ${template.purpose} parmi ${refused.length}`,
        refused,
        transient: all.length > 0 && all.every((r) => TRANSIENT_EXCLUSIONS.has(r)),
      };
    }

    /*
     * A CASCADE'S STAGE COUNT IS THE FLEET'S, NOT THE PLAN'S. One stage per ascending group of
     * the fact the topology escalates on — capability tier, or cost tier. A candidate whose group
     * is unknown goes last, in its own stage: unknown is not folded into a known group.
     */
    if (shape.grouped) {
      const groupKey = (a: Admitted) =>
        request.topology === "cheap-first-escalate" ? a.candidate.costTier : a.candidate.tier;
      const groups = [...new Set(viable.map(groupKey))].sort((a, b) => {
        if (a === undefined) return 1;
        if (b === undefined) return -1;
        return a - b;
      });
      for (const [g, key] of groups.entries()) {
        const members = viable.filter((a) => groupKey(a) === key);
        stages.push({
          index: g,
          role: template.role,
          purpose: g === 0 ? "produce" : "escalate",
          parallelism: 1,
          candidates: members.map((a) => a.candidate),
          maxAttempts,
          advanceWhen: template.advanceWhen,
          excludedWorkerIds,
          ...stageCeilings(members, ceilings),
          refused: g === 0 ? refused : [],
        });
      }
      writerWorkerIds.push(...viable.map((a) => a.candidate.workerId));
      writerModel ??= viable[0]?.candidate.model;
      continue;
    }

    const kept = viable.slice(0, template.width);
    stages.push({
      index: stages.length,
      role: template.role,
      purpose: template.purpose,
      parallelism: Math.min(template.parallelism, kept.length),
      candidates: kept.map((a) => a.candidate),
      maxAttempts,
      advanceWhen: template.advanceWhen,
      excludedWorkerIds,
      ...stageCeilings(kept, ceilings),
      refused,
    });

    if (!judging) {
      writerWorkerIds.push(...kept.map((a) => a.candidate.workerId));
      writerModel ??= kept[0]?.candidate.model;
    }
  }

  const terminateWhen: TerminationCondition[] = ["FINAL_STAGE_COMPLETED", "CANDIDATES_EXHAUSTED", "RETRY_BUDGET_EXHAUSTED"];
  if (stages.some((s) => JUDGE_PURPOSES.has(s.purpose))) {
    terminateWhen.push("REVIEW_APPROVED", "REVIEW_BLOCKED");
  }
  if (ceilings.tokens !== undefined || ceilings.moneyMicros !== undefined || ceilings.latencyMs !== undefined) {
    terminateWhen.push("CEILING_REACHED");
  }

  return {
    kind: "INFERENCE_PLAN",
    planVersion: INFERENCE_PLAN_VERSION,
    policyVersion: COMPUTE_POLICY_VERSION,
    plannedAt,
    topology: request.topology,
    ceilings,
    ceilingSources: sources,
    independence,
    diversity,
    stages,
    terminateWhen,
    evidenceRequired: EVIDENCE_REQUIRED,
  };
}

/**
 * A stage's own ceilings. The token and money ceilings are the plan's; the time budget is the
 * SMALLEST its candidates declare, because a stage that may run any of them must fit all of them.
 */
function stageCeilings(
  members: readonly Admitted[],
  ceilings: PlanCeilings,
): Pick<PlannedStage, "budgetMs" | "tokenCeiling" | "moneyCeilingMicros"> {
  const budgets = members
    .map((a) => a.candidate.budgetMs)
    .filter((b): b is number => b !== undefined);
  return {
    ...(budgets.length > 0 ? { budgetMs: Math.min(...budgets) } : {}),
    ...(ceilings.tokens !== undefined ? { tokenCeiling: ceilings.tokens } : {}),
    ...(ceilings.moneyMicros !== undefined ? { moneyCeilingMicros: ceilings.moneyMicros } : {}),
  };
}

/** The settlement margin a plan's budgets are proven against. Re-exported so a reader finds it. */
export { SETTLEMENT_MARGIN_MS };
