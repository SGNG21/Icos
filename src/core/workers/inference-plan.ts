import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import {
  ICOS_PRICE_REGISTRY,
  costMicros,
  resolvePrice,
  type PriceRegistry,
} from "@/core/pricing/registry";

import {
  COMPUTE_POLICY_VERSION,
  sameEffectiveModel,
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
  /**
   * TOTAL tokens a stage may consume — prompt plus completion, which is what both a context
   * window and a bill are measured in. It was documented as OUTPUT tokens, and that made two
   * things wrong at once: it was compared against a candidate's whole `contextWindow`, and the
   * worst-case cost charged ZERO prompt tokens, so a stage "proven" at 3 000 micros for 1 000
   * output tokens really cost 103 000 with a 100 k prompt.
   */
  tokens?: number;
  /**
   * Integer micros of {@link import("@/core/budget/contracts").BudgetCurrency}, per stage.
   * On its own this gates only candidates whose price is KNOWN; an unpriced candidate passes it,
   * because unknown stays unknown. Set `moneyEnforced` to make an unprovable cost a refusal —
   * without it a money ceiling is a preference, not a bound.
   */
  moneyMicros?: number;
  /** True: an unprovable cost is a refusal. The money ceiling then fails CLOSED. */
  moneyEnforced?: boolean;
  /** True: an unmeasured latency is a refusal. */
  latencyEnforced?: boolean;
}

export type CeilingSource = "governed" | "requested" | "unset";

/**
 * ONE diversity rule: `sameEffectiveModel`, the same relation review independence uses.
 *
 * There were two values, `"model"` and `"family"`, and `"model"` keyed on `effectiveModelKey`
 * alone. That is NOT the same-judge rule: `sameEffectiveModel` is key-match **OR** family-match,
 * and the pair its own comment names — `nvidia/nemotron-3-ultra-550b` and
 * `oc/nemotron-3-ultra-free` — normalizes to two different keys. Both were seated as "two
 * models" while being one model under two routes, so an ensemble could have no diversity at all.
 * Under the correct relation the two values are the same value, so there is one.
 *
 * It is deliberately coarse, in the same direction and for the same reason decision 0054 gives:
 * no suffix rule can know every route's naming, so Sonnet 4.6 and Sonnet 5 count as one judge.
 * Seating one fewer member is a smaller harm than an ensemble whose members are the same model.
 */
export type Diversity = "none" | "distinct-model";

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
   * Defaults to `required` whenever the plan has a JUDGING stage (review, critique, aggregate) —
   * whatever topology declared it. It keyed on the topology name, so a `mission-specific` review
   * and the `ensemble` aggregation (documented as "independent") defaulted to `preferred`, and a
   * second route to a writer's own model was seated as their judge.
   */
  independence?: "required" | "preferred";
  /**
   * Whether two candidates in one stage may be the same judge. `ensemble` defaults to
   * `distinct-model`. There is ONE rule — {@link sameEffectiveModel} — see {@link Diversity}.
   */
  diversity?: Diversity;
  /** Alternates per stage (`fallback`, `latency-first`, `quality-first`) or members (`ensemble`). */
  width?: number;
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
  /** Diversity: a candidate already seated in this stage is the same judge as this one. */
  | "DUPLICATE_MODEL"
  /** Independence is required and this candidate is the same judge as a writer candidate. */
  | "NOT_INDEPENDENT_OF_WRITER"
  /**
   * Independence or diversity is required and cannot be PROVEN for this candidate, because it
   * or the work it would judge declares no model. Unprovable is refused, never assumed distinct.
   */
  | "INDEPENDENCE_UNVERIFIABLE";

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
  /**
   * The router's own relaxation, when it applied one (`TIER_FALLBACK`): nothing met the required
   * tier, so this is among the strongest that remain. Carried because a relaxation that is not
   * recorded is a silent one.
   */
  routerFallback?: string;
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
  /**
   * Attempts this stage may spend: exactly one per declared candidate.
   *
   * This was a request field defaulting to 2 and clamped by `clampWidth`, so the plan AUTHORED a
   * retry budget — a number that belongs to the lease, the policy or QC, not to a routing shape —
   * and `topology: "single"`, whose own doc says a failure is the task's failure, shipped with
   * two attempts over one candidate. A plan declares WHO may run and in what order; how often to
   * re-run the same compute is not its decision.
   */
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
  diversity: Diversity;
  stages: readonly PlannedStage[];
  terminateWhen: readonly TerminationCondition[];
  /** Telemetry a run of this plan must produce. A stage with no evidence is an unproven stage. */
  evidenceRequired: readonly string[];
}

export interface NoViableRoute {
  kind: "NO_VIABLE_ROUTE";
  planVersion: string;
  /** The router's policy version, as a plan carries it: a refusal is re-derivable or it is anecdote. */
  policyVersion: string;
  plannedAt: string;
  topology: InferenceTopology;
  /** The EFFECTIVE ceilings a money or latency refusal turned on, and where each came from. */
  ceilings: PlanCeilings;
  ceilingSources: Readonly<Record<keyof PlanCeilings, CeilingSource>>;
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
/**
 * A numeric ceiling is usable only if it is a positive, finite number. Anything else is absent.
 *
 * A TOKEN ceiling is a count, so it is floored to a whole number — a narrowing, never a widening.
 * Measured: `tokens: 1000.5` made the worst-case cost NOT_REPRESENTABLE for a candidate whose
 * price IS known, so a money ceiling of 10 micros admitted a ~3 000-micro worst case: the money
 * ceiling silently gated nothing. A ceiling that floors below one token is no ceiling.
 */
function usable(value: number | boolean | undefined, whole = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const v = whole ? Math.floor(value) : value;
  return v > 0 ? v : undefined;
}

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
    /*
     * A CEILING THAT IS NOT A POSITIVE FINITE NUMBER IS NOT A CEILING. Measured: `r >= g` is
     * FALSE for NaN, so a caller passing `tokens: NaN` won the minimum and the effective ceiling
     * became NaN — after which every later comparison (`meanDurationMs > NaN`,
     * `contextWindow < NaN`) is false, so the ceiling gated nothing, and it serialized to `null`,
     * i.e. "no ceiling at all" on reload. Zero and negatives were accepted as narrowings too.
     * Both sides are validated, and an unusable value is DISCARDED rather than compared.
     */
    const g = usable(governed[key], key === "tokens");
    const r = usable(requested[key], key === "tokens");
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
 * The worst a stage can cost: every token of the ceiling billed at whichever side bills MORE.
 *
 * It charged the completion rate, justified by "which is never below the prompt rate". Nothing
 * enforces that: `recordDefect` only requires both rates positive, so a record with a prompt rate
 * ten thousand times the completion rate validated, and a candidate was admitted under a 5-micro
 * enforced ceiling with a "worst case" of 1 micro. An unproven assumption was deciding a money
 * refusal. Taking the dearer rate needs no assumption at all.
 *
 * Overestimating is the only safe direction under a cap, and the registry's integer-micros
 * arithmetic already rounds a non-zero remainder UP.
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
  const { promptMicrosPerMillion: pm, completionMicrosPerMillion: cm } = resolved.record;
  /* All on one side, so `totalTokens === prompt + completion` and UNPRICED_TOKENS cannot fire. */
  const cost = costMicros(resolved.record, {
    promptTokens: pm > cm ? tokens : 0,
    completionTokens: pm > cm ? 0 : tokens,
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

  /*
   * Both sides are TOTAL tokens now. While `ceilings.tokens` meant OUTPUT tokens this compared
   * an output ceiling against a whole context window, so a 200 k-context model passed a 100 k
   * "output" ceiling it could never emit.
   */
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

  /*
   * EVERY OPTIONAL FIELD IS OMITTED WHEN ABSENT, never present-and-undefined. The fields were
   * assigned unconditionally, so a plan carried undefined-valued keys: `toEqual` passed on a JSON
   * round trip while `toStrictEqual` threw, and the module's own round-trip test was written the
   * weaker way. A plan meant for a jsonb column must round-trip strictly.
   */
  const defined = <T,>(key: string, value: T | undefined) =>
    value === undefined ? {} : { [key]: value };

  return {
    exclusions,
    candidate: {
      workerId: verdict.workerId,
      ...defined("provider", profile.provider),
      ...defined("model", profile.model),
      ...defined("family", profile.family),
      ...defined("tier", profile.tier),
      ...defined("costTier", profile.costTier),
      ...defined("score", verdict.score?.total),
      ...defined("qualityScore", verdict.score?.quality),
      ...defined("reliabilityScore", verdict.score?.reliability),
      ...defined("budgetMs", budgetMs),
      ...defined("meanDurationMs", meanDurationMs),
      /* The router's own relaxation, carried so it is recorded rather than lost. */
      ...defined("routerFallback", verdict.fallback),
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
  /** Candidates to keep in this stage. Ignored when `grouped`: a group IS the stage. */
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
    /*
     * `cheap-first-escalate` is NOT here: it is a grouped topology, and the grouping below sorts
     * by the same cost tier. Re-sorting first changed nothing but which candidate happened to be
     * read as the writer's model — a dead branch with one live side effect.
     */
    default:
      return admitted;
  }
}

/**
 * Two candidates are the same judge when `sameEffectiveModel` says so. A candidate declaring NO
 * model cannot be proven distinct from anything, so it is treated as clashing — refusing a seat
 * we cannot justify, rather than claiming a diversity we cannot prove.
 */
function sameJudge(a: PlannedCandidate, b: PlannedCandidate): boolean {
  if (a.workerId === b.workerId) return true;
  if (a.model === undefined || b.model === undefined) return true;
  return sameEffectiveModel(a.model, b.model);
}

/**
 * Diversity, applied in order so the strongest candidate always keeps its seat.
 *
 * A candidate ALREADY REFUSED — by this module or by the router — takes no seat. Measured: an
 * `unhealthy` route to a model sorted first under `latency-first`, took the seat, and the HEALTHY
 * route to the same model was then dropped as a duplicate. The refused candidate was never going
 * to run, so it cost the stage its only viable member.
 */
function applyDiversity(
  admitted: readonly Admitted[],
  diversity: Diversity,
  refusedByRouter: (workerId: string) => boolean,
): Admitted[] {
  if (diversity === "none") return [...admitted];
  const seated: PlannedCandidate[] = [];
  return admitted.map((a) => {
    if (a.exclusions.length > 0 || refusedByRouter(a.candidate.workerId)) return a;
    if (seated.some((s) => sameJudge(s, a.candidate))) {
      const why: PlanExclusion =
        a.candidate.model === undefined ? "INDEPENDENCE_UNVERIFIABLE" : "DUPLICATE_MODEL";
      return { ...a, exclusions: [...a.exclusions, why] };
    }
    seated.push(a.candidate);
    return a;
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Planning                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const JUDGE_PURPOSES: ReadonlySet<StagePurpose> = new Set(["review", "critique", "aggregate"]);

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
  const shape = shapeOf(request);
  const independence =
    request.independence ??
    (shape.stages.some((s) => JUDGE_PURPOSES.has(s.purpose)) ? "required" : "preferred");
  const diversity = request.diversity ?? (request.topology === "ensemble" ? "distinct-model" : "none");
  const byId = new Map(pool.map((w) => [w.id, w] as const));

  /*
   * A REFUSAL MUST BE RE-DERIVABLE, like a plan. It carried neither the policy version nor the
   * ceilings, so "why was this refused?" could not be re-checked against the inputs that caused
   * it — and the ceilings are exactly what a money or latency refusal turns on.
   */
  const refuse = (
    atStage: number,
    role: StageRole,
    purpose: StagePurpose,
    reason: string,
    refused: readonly RefusedCandidate[],
  ): NoViableRoute => {
    const all = refused.flatMap((r) => r.because);
    return {
      kind: "NO_VIABLE_ROUTE",
      planVersion: INFERENCE_PLAN_VERSION,
      policyVersion: COMPUTE_POLICY_VERSION,
      plannedAt,
      topology: request.topology,
      ceilings,
      ceilingSources: sources,
      atStage,
      role,
      purpose,
      reason,
      refused,
      transient: all.length > 0 && all.every((r) => TRANSIENT_EXCLUSIONS.has(r)),
    };
  };

  if (shape.stages.length === 0) {
    return refuse(0, "writer", "produce", "topology mission-specific sans étape déclarée", []);
  }
  /*
   * A caller's own sequence is still checked for coherence: a purpose names what a stage DOES, so
   * a judging purpose on a writer (or the reverse) is a contradiction, and a judge before any
   * producer has nothing to judge and no worker to be independent of.
   */
  for (const [i, st] of shape.stages.entries()) {
    if (JUDGE_PURPOSES.has(st.purpose) !== (st.role === "reviewer")) {
      return refuse(i, st.role, st.purpose, `étape ${i}: rôle ${st.role} incompatible avec ${st.purpose}`, []);
    }
    if (st.role === "reviewer" && !shape.stages.slice(0, i).some((e) => e.role === "writer")) {
      return refuse(i, st.role, st.purpose, `étape ${i}: un juge sans étape productrice avant lui`, []);
    }
  }

  const stages: PlannedStage[] = [];
  /** Workers already used by a producing stage: a judge may never be one of them. */
  const writerWorkerIds: string[] = [];
  /**
   * EVERY model a producing stage declared — not just its first.
   *
   * This was one `string | undefined` assigned `kept[0]?.candidate.model`, while a producing
   * stage's default width is 2. Measured at the shipped defaults: writers
   * [nemotron-3-ultra-550b, oc/claude-sonnet-5-high], judge anthropic/claude-sonnet-5 — the same
   * effective model as writer candidate #2, with `independence: "required"` recorded on the plan.
   * A judge must be independent of whatever actually ran, and any declared candidate may run.
   */
  const writerModels: string[] = [];
  /** True once a producing stage declared a candidate with no model: independence is then unprovable. */
  let writerModelUnknown = false;

  /** Records a producing stage's candidates as work a later judge must be independent of. */
  const recordWriters = (produced: readonly Admitted[]) => {
    for (const a of produced) {
      writerWorkerIds.push(a.candidate.workerId);
      if (a.candidate.model === undefined) writerModelUnknown = true;
      else writerModels.push(a.candidate.model);
    }
  };

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
          /*
           * The router's SAME_MODEL_AS_WRITER is a PREFERENCE it relaxes, and it takes one key.
           * It is given the first writer model so that preference still works; the HARD rule for a
           * plan that declared independence is applied below, against every writer model.
           */
          ...(judging ? { writerModelKey: writerModels[0] } : {}),
        },
      },
    };

    const ranked = rankComputePool(pool, requirement);
    const scored = ranked.map((v) =>
      admit(v, byId.get(v.workerId)!, ceilings, request, prices, now),
    );

    /*
     * INDEPENDENCE AS A REFUSAL. The router avoids the writer's model while anything else
     * qualifies, then relaxes so work never stalls on a preference. A plan that DECLARED
     * independence as required cannot accept that relaxation: the stage refuses instead — and it
     * refuses against EVERY model its producing stages declared, not just the first.
     *
     * An unprovable independence is also a refusal. Previously, a writer with no declared model
     * skipped the check entirely AND left the router's own gate off, so a plan recorded
     * `independence: "required"` while nothing had been verified and no refusal said so.
     */
    const withIndependence =
      judging && independence === "required"
        ? scored.map((a) => {
            const why = independenceDefect(a.candidate, writerModels, writerModelUnknown);
            return why ? { ...a, exclusions: [...a.exclusions, why] } : a;
          })
        : scored;

    const routerRefusal = new Map(
      ranked.map((v) => [v.workerId, [...v.eligibility.reasons, ...v.exclusions]] as const),
    );
    /*
     * THE ROUTER'S VERDICT IS `selectable`, NOT "no exclusions". TIER_FALLBACK sets
     * `selectable: true` while LEAVING `BELOW_REQUIRED_TIER` in `exclusions` — the router saying
     * "nothing meets the tier, these are the strongest that remain, and it is recorded". Reading
     * the exclusion list instead made the plan OVERRULE the authority it claims to defer to: the
     * plan returned a permanent NO_VIABLE_ROUTE where a bare dispatch would have run, and the
     * `fallback` provenance was dropped. The relaxation is now respected and carried.
     */
    const refusedByRouter = (id: string) => ranked.find((v) => v.workerId === id)?.selectable !== true;
    const ordered = reorder(request.topology, withIndependence);
    const diverse = applyDiversity(ordered, judging ? "none" : diversity, refusedByRouter);

    const viable = diverse.filter(
      (a) => a.exclusions.length === 0 && !refusedByRouter(a.candidate.workerId),
    );
    const refused: RefusedCandidate[] = diverse
      .filter((a) => !viable.includes(a))
      .map((a) => {
        const because = [
          ...(refusedByRouter(a.candidate.workerId)
            ? (routerRefusal.get(a.candidate.workerId) ?? [])
            : []),
          ...a.exclusions,
        ];
        return {
          workerId: a.candidate.workerId,
          because,
          /*
           * Only when the cost is what refused it. It was attached to EVERY refusal, so a
           * candidate excluded as the writer's own worker carried "no token ceiling" beside it —
           * sending an operator to the price registry over a review-independence rule, which is
           * the exact failure this field was added to prevent.
           */
          ...(because.includes("COST_UNPROVABLE") &&
          a.candidate.costUnprovableBecause !== undefined
            ? { costUnprovableBecause: a.candidate.costUnprovableBecause }
            : {}),
        };
      });

    if (viable.length === 0) {
      return refuse(
        index,
        template.role,
        template.purpose,
        refused.length === 0
          ? `aucun worker enregistré pour l'étape ${template.purpose}`
          : `aucun candidat viable pour l'étape ${template.purpose} parmi ${refused.length}`,
        refused,
      );
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
          maxAttempts: members.length,
          advanceWhen: template.advanceWhen,
          excludedWorkerIds,
          ...stageCeilings(members, ceilings),
          /*
           * The refusals belong to EVERY stage of a cascade: one ranking produced them all, so a
           * candidate refused is refused for the whole cascade. Attaching them only to stage 0
           * made every escalation stage claim it had refused nobody.
           */
          refused,
        });
      }
      recordWriters(viable);
      continue;
    }

    const kept = viable.slice(0, template.width);
    /*
     * AN ENSEMBLE OF ONE IS NOT AN ENSEMBLE. Its whole value is that several DISTINCT judges
     * produce independently; with one seatable member the topology silently degrades to `single`
     * while the plan still says `ensemble`. Refuse and say which.
     */
    if (template.purpose === "member" && kept.length < 2) {
      return refuse(
        index,
        template.role,
        template.purpose,
        `ensemble: ${kept.length} membre(s) distinct(s) seulement, il en faut au moins 2`,
        refused,
      );
    }
    stages.push({
      index: stages.length,
      role: template.role,
      purpose: template.purpose,
      parallelism: Math.min(template.parallelism, kept.length),
      candidates: kept.map((a) => a.candidate),
      maxAttempts: kept.length,
      advanceWhen: template.advanceWhen,
      excludedWorkerIds,
      ...stageCeilings(kept, ceilings),
      refused,
    });

    if (!judging) recordWriters(kept);
  }

  const terminateWhen: TerminationCondition[] = ["FINAL_STAGE_COMPLETED", "CANDIDATES_EXHAUSTED"];
  /*
   * A review can end a plan whenever one can advance it. A `cascade` has no judging stage of its
   * own yet escalates on REVIEW_REQUEST_CHANGES — ICOS reviews every attempt independently of the
   * topology — so keying this on a judge stage alone left a cascade able to advance on a review
   * verdict while declaring no review outcome could terminate it.
   */
  if (
    stages.some(
      (s) => JUDGE_PURPOSES.has(s.purpose) || s.advanceWhen.includes("REVIEW_REQUEST_CHANGES"),
    )
  ) {
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
 * Why this candidate cannot judge work produced by `writerModels` — or `undefined` when it can.
 *
 * Unprovable is refused. A judge with no declared model cannot be shown independent, and work
 * whose producer declared no model cannot be shown to have a different judge; in both cases the
 * honest answer is a named refusal, not an assumption in either direction.
 */
function independenceDefect(
  candidate: PlannedCandidate,
  writerModels: readonly string[],
  writerModelUnknown: boolean,
): PlanExclusion | undefined {
  if (writerModelUnknown || candidate.model === undefined) return "INDEPENDENCE_UNVERIFIABLE";
  const model = candidate.model;
  return writerModels.some((w) => sameEffectiveModel(model, w))
    ? "NOT_INDEPENDENT_OF_WRITER"
    : undefined;
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
