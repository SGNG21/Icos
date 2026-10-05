import { describe, expect, it, vi } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { ComputeOutcome } from "@/core/workers/compute-routing";
import {
  INFERENCE_PLAN_VERSION,
  INFERENCE_TOPOLOGIES,
  effectiveCeilings,
  planInference,
  type InferencePlan,
  type InferencePlanRequest,
  type NoViableRoute,
  type PlanBase,
  type PlanCeilings,
} from "@/core/workers/inference-plan";
import type { PriceRecord, PriceRegistry } from "@/core/pricing/registry";
import { MICROS_PER_UNIT } from "@/core/pricing/registry";
import { effectiveModelKey, sameEffectiveModel } from "@/core/workers/compute-routing";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import {
  candidateRegistration,
  candidateWorkerId,
  classifyModels,
} from "@/server/workers/compute-fleet";

/*
 * GOVERNED INFERENCE PLANS — decision 0071.
 *
 * WHAT THIS FILE PROVES, STATED EXACTLY. `base()` routes for real and hands the planner the
 * router's OWN requirement — so the compute context, the history aggregation, the clock and the
 * lease are all the router's. The planner then calls `rankComputePool` itself, once per stage.
 *
 * It does NOT prove "no candidate the router refused can appear": that property is about every
 * stage's own ranking, and `PLAN_NEVER_OVERRULES_THE_ROUTER` below is what proves it, by
 * re-running the router per emitted stage and checking each seated candidate against its verdict.
 * Three tests deliberately inject a `load` snapshot the router did not produce, to reach the
 * capacity gates.
 */

const NOW = new Date("2026-10-05T12:00:00.000Z");
const PROBED = new Date(NOW.getTime() - 10_000).toISOString();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MODELS = {
  haiku: "anthropic/claude-haiku-4-5",
  n120: "nvidia/nemotron-3-super-120b",
  sonnet: "anthropic/claude-sonnet-5",
  sol: "openai/gpt-5.6-sol",
  n550: "nvidia/nemotron-3-ultra-550b",
  /*
   * A SECOND ROUTE TO THE SAME MODEL, under a name `effectiveModelKey` does NOT collapse — the
   * exact pair `compute-routing.ts` names in its own comment. `sameEffectiveModel` collapses it
   * via the family. Several proofs below turn on that difference.
   */
  n550alt: "oc/nemotron-3-ultra-free",
  opus: "anthropic/claude-opus-5",
} as const;
type Key = keyof typeof MODELS;

function candidate(key: Key, over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry {
  const [model] = classifyModels([MODELS[key]]);
  const reg = candidateRegistration(model!, {
    runtime: "binary",
    capabilities: ["code_editing", "review"],
  });
  return {
    ...reg,
    features: [],
    supportsTools: true,
    supportsStructuredOutput: true,
    status: "active",
    health: "healthy",
    availability: "available",
    tags: [],
    lastProbeAt: PROBED,
    lastProbeOutcome: "ok",
    capacityPoolLimit: null,
    capacityPool: null,
    updatedAt: PROBED,
    ...over,
    metadata: { ...reg.metadata, ...(over.metadata ?? {}) },
  };
}

const id = (key: Key) => candidateWorkerId(MODELS[key]);

/** A registered worker declaring NO model. Its metadata key is absent, not empty. */
function modelless(key: Key): WorkerRegistryEntry {
  const w = candidate(key);
  return {
    ...w,
    metadata: Object.fromEntries(Object.entries(w.metadata).filter(([k]) => k !== "model")),
  };
}

/** Routes for real, then returns the router's own requirement — the planner's only input. */
async function base(
  workers: WorkerRegistryEntry[],
  opts: { history?: ComputeOutcome[]; complexity?: "low" | "medium" | "high" } = {},
): Promise<PlanBase> {
  const router = new CapabilityRouter(new InMemoryWorkerRegistryStore(workers), {
    now: () => NOW,
    computeHistory: async () => opts.history ?? [],
    executionLeaseMs: 25 * 60_000,
    defaultBudgetMs: () => 15 * 60_000,
    steersModel: () => true,
  });
  const result = await router.route(
    { requiredCapabilities: ["code_editing"] },
    {
      role: "writer",
      complexity: opts.complexity ?? "medium",
      repositoryMutation: true,
      correctionAttempt: 0,
      priorAttempts: [],
    },
  );
  if (!result.requirement.compute) throw new Error("router produced no compute context");
  return result.requirement as PlanBase;
}

const plan = (
  workers: WorkerRegistryEntry[],
  b: PlanBase,
  request: InferencePlanRequest,
  prices?: PriceRegistry,
) => planInference(workers, b, request, prices);

const isPlan = (o: unknown): o is InferencePlan =>
  (o as { kind?: string }).kind === "INFERENCE_PLAN";
const expectPlan = (o: InferencePlan | NoViableRoute): InferencePlan => {
  if (!isPlan(o)) throw new Error(`expected a plan, got NO_VIABLE_ROUTE: ${o.reason}`);
  return o;
};
const expectRefusal = (o: InferencePlan | NoViableRoute): NoViableRoute => {
  if (isPlan(o)) throw new Error("expected NO_VIABLE_ROUTE, got a plan");
  return o;
};

const NO_CEILINGS: PlanCeilings = {};

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — topologies", () => {
  it("SINGLE_ROUTE: one stage, one candidate, no alternate", async () => {
    const workers = [candidate("sonnet"), candidate("n120"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), { topology: "single", governed: NO_CEILINGS }),
    );
    expect(p.planVersion).toBe(INFERENCE_PLAN_VERSION);
    expect(p.policyVersion).toBe("compute-routing/1");
    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.candidates).toHaveLength(1);
    expect(p.stages[0]!.role).toBe("writer");
    expect(p.stages[0]!.advanceWhen).toEqual(["STAGE_COMPLETED"]);
  });

  it("FALLBACK_ROUTE: ordered alternates inside ONE declared stage", async () => {
    const workers = [candidate("sonnet"), candidate("n120"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "fallback",
        governed: NO_CEILINGS,
        width: 3,
      }),
    );
    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.candidates).toHaveLength(3);
    /* The order is the ROUTER's score, descending. */
    const scores = p.stages[0]!.candidates.map((c) => c.score!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("CASCADE_ROUTE: one stage per ascending fleet tier, escalating on failure", async () => {
    const workers = [candidate("haiku"), candidate("sonnet"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers, { complexity: "low" }), {
        topology: "cascade",
        governed: NO_CEILINGS,
      }),
    );
    expect(p.stages.map((s) => s.candidates[0]!.tier)).toEqual([1, 3, 5]);
    expect(p.stages.map((s) => s.purpose)).toEqual(["produce", "escalate", "escalate"]);
    expect(p.stages[0]!.advanceWhen).toContain("REVIEW_REQUEST_CHANGES");
    expect(p.stages[0]!.advanceWhen).toContain("STAGE_FAILED");
  });

  it("cheap-first-escalate orders the cascade by KNOWN cost tier", async () => {
    const workers = [candidate("opus"), candidate("n550"), candidate("haiku")];
    const p = expectPlan(
      plan(workers, await base(workers, { complexity: "low" }), {
        topology: "cheap-first-escalate",
        governed: NO_CEILINGS,
      }),
    );
    expect(p.stages.map((s) => s.candidates[0]!.costTier)).toEqual([1, 2, 5]);
  });

  it("CRITIQUE_ROUTE: produce, independent critique, revise", async () => {
    const workers = [candidate("sonnet"), candidate("opus"), candidate("n550")];
    const p = expectPlan(
      plan(workers, await base(workers), { topology: "critique", governed: NO_CEILINGS }),
    );
    expect(p.stages.map((s) => `${s.role}:${s.purpose}`)).toEqual([
      "writer:produce",
      "reviewer:critique",
      "writer:revise",
    ]);
    /* The critic may not be a worker the producing stage could use. */
    const producers = p.stages[0]!.candidates.map((c) => c.workerId);
    expect(p.stages[1]!.excludedWorkerIds).toEqual(expect.arrayContaining(producers));
    for (const c of p.stages[1]!.candidates) expect(producers).not.toContain(c.workerId);
  });

  it("REVIEWER_ROUTE: produce then one independent review", async () => {
    const workers = [candidate("sonnet"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "reviewer",
        governed: NO_CEILINGS,
        width: 1,
      }),
    );
    expect(p.stages.map((s) => s.role)).toEqual(["writer", "reviewer"]);
    expect(p.stages[1]!.candidates).toHaveLength(1);
    expect(p.terminateWhen).toContain("REVIEW_APPROVED");
  });

  it("ENSEMBLE_ROUTE: diverse members in parallel, then one aggregation", async () => {
    const workers = [candidate("sonnet"), candidate("n550"), candidate("sol"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "ensemble",
        governed: NO_CEILINGS,
        width: 3,
      }),
    );
    expect(p.stages[0]!.purpose).toBe("member");
    expect(p.stages[0]!.parallelism).toBe(3);
    expect(p.stages[0]!.candidates).toHaveLength(3);
    expect(p.stages[1]!.purpose).toBe("aggregate");
    expect(p.diversity).toBe("distinct-model");
  });

  it("latency-first orders on MEASURED duration; unmeasured sorts last", async () => {
    const workers = [candidate("sonnet"), candidate("opus"), candidate("n120")];
    const history: ComputeOutcome[] = [
      { workerId: id("opus"), taskId: "t1", attempt: 1, state: "completed", durationMs: 1_000, at: ago(60_000) },
      { workerId: id("sonnet"), taskId: "t2", attempt: 1, state: "completed", durationMs: 9_000, at: ago(60_000) },
    ];
    const p = expectPlan(
      plan(workers, await base(workers, { history }), {
        topology: "latency-first",
        governed: NO_CEILINGS,
        width: 3,
      }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([
      id("opus"),
      id("sonnet"),
      id("n120"),
    ]);
    expect(p.stages[0]!.candidates[2]!.meanDurationMs).toBeUndefined();
  });

  it("quality-first orders on the MEASURED review-quality rate, not the aggregate score", async () => {
    const workers = [candidate("sonnet"), candidate("n120")];
    const approvals = (workerId: string, n: number): ComputeOutcome[] =>
      Array.from({ length: n }, (_, i) => ({
        workerId,
        taskId: `q${workerId}${i}`,
        attempt: 1,
        state: "completed" as const,
        reviewVerdict: "APPROVE",
        at: ago(60_000 + i),
      }));
    const p = expectPlan(
      plan(workers, await base(workers, { history: approvals(id("n120"), 20) }), {
        topology: "quality-first",
        governed: NO_CEILINGS,
        width: 2,
      }),
    );
    const [first, second] = p.stages[0]!.candidates;
    expect(first!.workerId).toBe(id("n120"));
    expect(first!.qualityScore!).toBeGreaterThan(second!.qualityScore!);
  });

  it("mission-specific uses the caller's role sequence and nothing more", async () => {
    const workers = [candidate("sonnet"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "mission-specific",
        governed: NO_CEILINGS,
        width: 1,
        stages: [
          { role: "writer", purpose: "produce" },
          { role: "writer", purpose: "revise" },
          { role: "reviewer", purpose: "review" },
        ],
      }),
    );
    expect(p.stages.map((s) => `${s.role}:${s.purpose}`)).toEqual([
      "writer:produce",
      "writer:revise",
      "reviewer:review",
    ]);
  });

  it("mission-specific with no declared stage is NO_VIABLE_ROUTE, not an empty plan", async () => {
    const workers = [candidate("sonnet")];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "mission-specific",
        governed: NO_CEILINGS,
      }),
    );
    expect(r.reason).toMatch(/sans étape déclarée/);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — fails closed", () => {
  it("NO_VIABLE_ROUTE carries a durable reason and every refusal", async () => {
    const workers = [candidate("sonnet", { health: "unhealthy" }), candidate("opus", { status: "inactive" })];
    const r = expectRefusal(
      plan(workers, await base(workers), { topology: "single", governed: NO_CEILINGS }),
    );
    expect(r.kind).toBe("NO_VIABLE_ROUTE");
    expect(r.atStage).toBe(0);
    expect(r.refused.map((x) => x.because).flat()).toEqual(
      expect.arrayContaining(["HEALTH_NOT_HEALTHY", "STATUS_NOT_ACTIVE"]),
    );
    expect(r.transient).toBe(false);
  });

  it("a refusal caused ONLY by capacity is transient: back-pressure, not a verdict", async () => {
    const workers = [candidate("sonnet", { maxConcurrency: 1 })];
    const b = await base(workers);
    const saturated: PlanBase = {
      ...b,
      load: { byWorkerId: { [id("sonnet")]: 1 } },
    };
    const r = expectRefusal(plan(workers, saturated, { topology: "single", governed: NO_CEILINGS }));
    expect(r.refused[0]!.because).toEqual(["AT_CAPACITY"]);
    expect(r.transient).toBe(true);
  });

  it("an empty fleet refuses rather than planning an unroutable stage", async () => {
    const workers = [candidate("sonnet")];
    const r = expectRefusal(
      plan([], await base(workers), { topology: "single", governed: NO_CEILINGS }),
    );
    expect(r.reason).toMatch(/aucun worker enregistré/);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — budgets cannot widen", () => {
  it("every numeric ceiling takes the minimum of governed and requested", () => {
    const { ceilings, sources } = effectiveCeilings(
      { latencyMs: 10_000, tokens: 4_000, moneyMicros: 500 },
      { latencyMs: 60_000, tokens: 1_000, moneyMicros: 9_999_999 },
    );
    expect(ceilings.latencyMs).toBe(10_000);
    expect(ceilings.tokens).toBe(1_000);
    expect(ceilings.moneyMicros).toBe(500);
    expect(sources).toMatchObject({
      latencyMs: "governed",
      tokens: "requested",
      moneyMicros: "governed",
    });
  });

  it("enforcement can only be turned ON by a caller, never off", () => {
    expect(
      effectiveCeilings({ moneyEnforced: true, latencyEnforced: true }, {
        moneyEnforced: false,
        latencyEnforced: false,
      }).ceilings,
    ).toMatchObject({ moneyEnforced: true, latencyEnforced: true });
    expect(
      effectiveCeilings({}, { moneyEnforced: true }).ceilings.moneyEnforced,
    ).toBe(true);
  });

  it("a caller cannot introduce a looser ceiling where the authority set none", () => {
    /* No ceiling to widen: the caller's own value stands, and is recorded as the caller's. */
    const { ceilings, sources } = effectiveCeilings({}, { tokens: 100_000 });
    expect(ceilings.tokens).toBe(100_000);
    expect(sources.tokens).toBe("requested");
    /* But where the authority DID set one, the caller's larger number is discarded. */
    expect(effectiveCeilings({ tokens: 8 }, { tokens: 100_000 }).ceilings.tokens).toBe(8);
  });

  it("the plan records the EFFECTIVE ceilings and where each came from", async () => {
    const workers = [candidate("sonnet")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "single",
        governed: { tokens: 4_000 },
        requested: { tokens: 400_000, latencyMs: 30_000 },
      }),
    );
    expect(p.ceilings.tokens).toBe(4_000);
    expect(p.ceilingSources.tokens).toBe("governed");
    expect(p.ceilingSources.latencyMs).toBe("requested");
    expect(p.stages[0]!.tokenCeiling).toBe(4_000);
    expect(p.terminateWhen).toContain("CEILING_REACHED");
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — health is the probe's", () => {
  it("PROVIDER_HEALTH: a saturated provider capacity pool removes all its models", async () => {
    const workers = [
      candidate("sonnet", { capacityPool: "anthropic", capacityPoolLimit: 1 }),
      candidate("opus", { capacityPool: "anthropic", capacityPoolLimit: 1 }),
      candidate("n120"),
    ];
    const b = await base(workers);
    const saturated: PlanBase = {
      ...b,
      load: {
        byWorkerId: {},
        byCapacityPool: { anthropic: 1 },
        capacityPoolLimits: { anthropic: 1 },
      },
    };
    const p = expectPlan(
      plan(workers, saturated, { topology: "fallback", governed: NO_CEILINGS, width: 4 }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("CAPACITY_POOL_SATURATED");
  });

  it("MODEL_HEALTH: stale probe evidence is not health, and unprobed is never a pass", async () => {
    const workers = [
      candidate("sonnet", { lastProbeAt: ago(10 * 60_000) }),
      candidate("opus", { lastProbeAt: null, lastProbeOutcome: "never" }),
      candidate("n120"),
    ];
    const p = expectPlan(
      plan(workers, await base(workers), { topology: "fallback", governed: NO_CEILINGS, width: 4 }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    const because = p.stages[0]!.refused.flatMap((r) => r.because);
    expect(because).toContain("HEALTH_EVIDENCE_STALE");
    expect(because).toContain("HEALTH_EVIDENCE_MISSING");
  });

  it("a model that just refused us is in cooldown and is not planned", async () => {
    const workers = [candidate("sonnet"), candidate("n120")];
    const history: ComputeOutcome[] = [
      {
        workerId: id("sonnet"),
        taskId: "t1",
        attempt: 1,
        state: "failed",
        failureClass: "RATE_LIMITED",
        at: ago(30_000),
      },
    ];
    const p = expectPlan(
      plan(workers, await base(workers, { history }), {
        topology: "fallback",
        governed: NO_CEILINGS,
        width: 2,
      }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("PROVIDER_COOLDOWN");
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — diversity and independence", () => {
  it("DIVERSITY: an ensemble never seats two routes to one model", async () => {
    /* Two Sonnet routes and two Nemotron routes: four workers, two families. */
    const workers = [
      candidate("sonnet"),
      candidate("sonnet", {
        id: "11111111-1111-4111-8111-111111111111",
        metadata: { model: "oc/claude-sonnet-5-high", provider: "oc" },
      }),
      candidate("n550"),
      candidate("n550", {
        id: "22222222-2222-4222-8222-222222222222",
        metadata: { model: "oc/nemotron-3-ultra-free", provider: "oc" },
      }),
      /*
       * A third model, for the aggregation. Without it this test passed only because the
       * aggregator was a second route to a member's own model — the independence default the
       * second falsifier closed.
       */
      candidate("opus"),
    ];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "ensemble",
        governed: NO_CEILINGS,
        width: 2,
      }),
    );
    const families = p.stages[0]!.candidates.map((c) => c.family);
    expect(new Set(families).size).toBe(families.length);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("DUPLICATE_MODEL");
  });

  it("diversity keeps one route per model, across providers", async () => {
    const workers = [
      candidate("sonnet"),
      candidate("sonnet", {
        id: "11111111-1111-4111-8111-111111111111",
        metadata: { model: "oc/claude-sonnet-5", provider: "oc" },
      }),
      candidate("n120"),
    ];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "fallback",
        governed: NO_CEILINGS,
        diversity: "distinct-model",
        width: 3,
      }),
    );
    expect(p.stages[0]!.candidates).toHaveLength(2);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("DUPLICATE_MODEL");
  });

  it("REVIEWER_INDEPENDENCE: the writer's own worker can never review", async () => {
    const workers = [candidate("sonnet"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "reviewer",
        governed: NO_CEILINGS,
        width: 1,
      }),
    );
    const writer = p.stages[0]!.candidates[0]!.workerId;
    expect(p.stages[1]!.candidates.map((c) => c.workerId)).not.toContain(writer);
  });

  it("REVIEWER_INDEPENDENCE: with independence required, a same-family judge REFUSES", async () => {
    /* Two routes to one judge: the only possible reviewer is the writer's model under another name. */
    const workers = [
      candidate("sonnet"),
      candidate("sonnet", {
        id: "11111111-1111-4111-8111-111111111111",
        metadata: { model: "oc/claude-sonnet-5-high", provider: "oc" },
      }),
    ];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "reviewer",
        governed: NO_CEILINGS,
        width: 1,
        independence: "required",
      }),
    );
    expect(r.purpose).toBe("review");
    expect(r.refused.flatMap((x) => x.because)).toContain("NOT_INDEPENDENT_OF_WRITER");
  });

  it("with independence only PREFERRED, the same-family judge is planned rather than stalling", async () => {
    const workers = [
      candidate("sonnet"),
      candidate("sonnet", {
        id: "11111111-1111-4111-8111-111111111111",
        metadata: { model: "oc/claude-sonnet-5-high", provider: "oc" },
      }),
    ];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "reviewer",
        governed: NO_CEILINGS,
        width: 1,
        independence: "preferred",
      }),
    );
    expect(p.stages[1]!.candidates).toHaveLength(1);
    expect(p.stages[1]!.candidates[0]!.family).toBe("CLAUDE_SONNET");
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — money fails closed on an unknown price", () => {
  const priced = (modelId: string, microsPerMillion: number): PriceRecord => ({
    provider: modelId.split("/")[0]!,
    modelId,
    currency: "EUR",
    promptMicrosPerMillion: microsPerMillion,
    completionMicrosPerMillion: microsPerMillion,
    provenance: "fixture de test, pas un tarif réel",
    effectiveAt: "2026-10-01T00:00:00.000Z",
    staleAfter: "2026-12-01T00:00:00.000Z",
  });

  it("UNKNOWN_PRICE: with money enforced, an unpriced model is refused — never estimated", async () => {
    const workers = [candidate("sonnet"), candidate("n120")];
    const prices: PriceRegistry = [priced("nvidia/nemotron-3-super-120b", MICROS_PER_UNIT)];
    const p = expectPlan(
      plan(
        workers,
        await base(workers),
        {
          topology: "fallback",
          governed: { tokens: 1_000, moneyMicros: 10 * MICROS_PER_UNIT, moneyEnforced: true },
          width: 2,
        },
        prices,
      ),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("COST_UNPROVABLE");
  });

  it("the whole plan refuses when money is enforced and NO price is known", async () => {
    const workers = [candidate("sonnet"), candidate("n120")];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "single",
        governed: { tokens: 1_000, moneyMicros: MICROS_PER_UNIT, moneyEnforced: true },
      }),
    );
    expect(r.refused.flatMap((x) => x.because)).toContain("COST_UNPROVABLE");
    expect(r.transient).toBe(false);
  });

  it("money enforced with NO token ceiling refuses: an unbounded worst case is not provable", async () => {
    const workers = [candidate("n120")];
    const prices: PriceRegistry = [priced("nvidia/nemotron-3-super-120b", MICROS_PER_UNIT)];
    const r = expectRefusal(
      plan(
        workers,
        await base(workers),
        { topology: "single", governed: { moneyMicros: MICROS_PER_UNIT, moneyEnforced: true } },
        prices,
      ),
    );
    expect(r.refused[0]!.because).toContain("COST_UNPROVABLE");
  });

  it("without money enforcement an unknown price is recorded as unknown, not as zero", async () => {
    const workers = [candidate("sonnet")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "single",
        governed: { tokens: 1_000 },
      }),
    );
    const only = p.stages[0]!.candidates[0]!;
    expect(only.worstCaseCostMicros).toBeUndefined();
    expect(only.costUnprovableBecause).toMatch(/ABSENT/);
  });

  it("COST_WHEN_KNOWN: the worst case is the token ceiling at the completion rate, rounded up", async () => {
    const workers = [candidate("n120")];
    /* 3 EUR per million tokens; 1 000 tokens = 3 000 micros. */
    const prices: PriceRegistry = [priced("nvidia/nemotron-3-super-120b", 3 * MICROS_PER_UNIT)];
    const p = expectPlan(
      plan(
        workers,
        await base(workers),
        { topology: "single", governed: { tokens: 1_000, moneyMicros: 5_000 } },
        prices,
      ),
    );
    expect(p.stages[0]!.candidates[0]!.worstCaseCostMicros).toBe(3_000);
  });

  it("a worst case over the money ceiling is refused even though the price IS known", async () => {
    const workers = [candidate("n120")];
    const prices: PriceRegistry = [priced("nvidia/nemotron-3-super-120b", 3 * MICROS_PER_UNIT)];
    const r = expectRefusal(
      plan(
        workers,
        await base(workers),
        { topology: "single", governed: { tokens: 1_000, moneyMicros: 2_999 } },
        prices,
      ),
    );
    expect(r.refused[0]!.because).toContain("MONEY_CEILING_EXCEEDED");
  });

  it("a STALE price is an unknown price, not an almost-right one", async () => {
    const workers = [candidate("n120")];
    const stale: PriceRegistry = [
      {
        ...priced("nvidia/nemotron-3-super-120b", MICROS_PER_UNIT),
        effectiveAt: "2026-01-01T00:00:00.000Z",
        staleAfter: "2026-02-01T00:00:00.000Z",
      },
    ];
    const r = expectRefusal(
      plan(
        workers,
        await base(workers),
        {
          topology: "single",
          governed: { tokens: 1_000, moneyMicros: MICROS_PER_UNIT, moneyEnforced: true },
        },
        stale,
      ),
    );
    expect(r.refused[0]!.because).toContain("COST_UNPROVABLE");
    expect(r.refused[0]!.costUnprovableBecause).toMatch(/STALE/);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — the other ceilings", () => {
  it("LATENCY: a candidate measurably slower than the ceiling is not planned", async () => {
    const workers = [candidate("sonnet"), candidate("n120")];
    const history: ComputeOutcome[] = [
      { workerId: id("sonnet"), taskId: "t1", attempt: 1, state: "completed", durationMs: 90_000, at: ago(60_000) },
      { workerId: id("n120"), taskId: "t2", attempt: 1, state: "completed", durationMs: 5_000, at: ago(60_000) },
    ];
    const p = expectPlan(
      plan(workers, await base(workers, { history }), {
        topology: "fallback",
        governed: { latencyMs: 30_000 },
        width: 2,
      }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("LATENCY_CEILING_EXCEEDED");
  });

  it("an UNMEASURED latency is not gated by default, and IS gated when enforced", async () => {
    const workers = [candidate("sonnet")];
    const b = await base(workers);
    expect(
      expectPlan(
        plan(workers, b, { topology: "single", governed: { latencyMs: 30_000 } }),
      ).stages[0]!.candidates,
    ).toHaveLength(1);
    expect(
      expectRefusal(
        plan(workers, b, {
          topology: "single",
          governed: { latencyMs: 30_000, latencyEnforced: true },
        }),
      ).refused[0]!.because,
    ).toContain("LATENCY_UNMEASURED");
  });

  it("TOKENS: a declared context window below the token ceiling is refused", async () => {
    const workers = [
      candidate("sonnet", { metadata: { contextWindow: "8000" } }),
      candidate("n120", { metadata: { contextWindow: "200000" } }),
    ];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "fallback",
        governed: { tokens: 100_000 },
        width: 2,
      }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("CONTEXT_BELOW_TOKEN_CEILING");
  });

  it("TOOLS: a stage requiring tools refuses a candidate that declares none", async () => {
    const workers = [candidate("sonnet", { supportsTools: false }), candidate("n120")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "fallback",
        governed: NO_CEILINGS,
        width: 2,
        requiresTools: true,
      }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("TOOLS_UNSUPPORTED");
  });

  it("STRUCTURED OUTPUT: likewise, and recorded", async () => {
    const workers = [candidate("sonnet", { supportsStructuredOutput: false }), candidate("n120")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "fallback",
        governed: NO_CEILINGS,
        width: 2,
        requiresStructuredOutput: true,
      }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n120")]);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain(
      "STRUCTURED_OUTPUT_UNSUPPORTED",
    );
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("inference plan — durability and determinism", () => {
  it("a plan survives JSON round-tripping STRICTLY, with no undefined-valued keys", async () => {
    /*
     * This asserted `toEqual(roundTrip, roundTrip)` — two round trips of the SAME value, which
     * passes for any object whatsoever. The honest assertion compares the round trip with the
     * ORIGINAL, strictly, and it failed: optional fields were assigned unconditionally, so a plan
     * carried present-but-undefined keys that JSON drops.
     */
    const workers = [candidate("sonnet"), candidate("opus"), candidate("n120")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "critique",
        governed: { tokens: 4_000, latencyMs: 60_000 },
        width: 2,
      }),
    );
    expect(JSON.parse(JSON.stringify(p))).toStrictEqual(p);
    const everyKey = (o: unknown): string[] =>
      typeof o !== "object" || o === null
        ? []
        : Array.isArray(o)
          ? o.flatMap(everyKey)
          : Object.entries(o).flatMap(([k, v]) => (v === undefined ? [k] : everyKey(v)));
    expect(everyKey(p)).toEqual([]);
  });

  it("a refusal round-trips strictly too, and carries what caused it", async () => {
    const workers = [candidate("sonnet", { health: "unhealthy" })];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "single",
        governed: { tokens: 4_000 },
        requested: { latencyMs: 10_000 },
      }),
    );
    expect(JSON.parse(JSON.stringify(r))).toStrictEqual(r);
    /* A refusal that cannot be re-derived against its inputs is anecdote, not evidence. */
    expect(r.policyVersion).toBe("compute-routing/1");
    expect(r.ceilings).toMatchObject({ tokens: 4_000, latencyMs: 10_000 });
    expect(r.ceilingSources).toMatchObject({ tokens: "governed", latencyMs: "requested" });
  });

  it("DETERMINISM: planning reads no clock, no randomness and starts no timer", async () => {
    /*
     * "Same inputs, same plan" is near-tautological for a pure function with an injected clock:
     * it can only catch a wall-clock read. This catches the read itself.
     */
    const workers = [candidate("sonnet"), candidate("opus"), candidate("n120"), candidate("n550")];
    const b = await base(workers);
    const touched: string[] = [];
    const spies = [
      vi.spyOn(Date, "now").mockImplementation(() => {
        touched.push("Date.now");
        return 0;
      }),
      vi.spyOn(Math, "random").mockImplementation(() => {
        touched.push("Math.random");
        return 0;
      }),
      vi.spyOn(globalThis, "setTimeout").mockImplementation((() => {
        touched.push("setTimeout");
        return 0;
      }) as unknown as typeof setTimeout),
      vi.spyOn(globalThis, "setInterval").mockImplementation((() => {
        touched.push("setInterval");
        return 0;
      }) as unknown as typeof setInterval),
    ];
    try {
      for (const topology of INFERENCE_TOPOLOGIES) {
        if (topology === "mission-specific") continue;
        plan(workers, b, { topology, governed: { tokens: 4_000 }, width: 3 });
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(touched).toEqual([]);
  });

  it("the same inputs always produce the same plan, byte for byte", async () => {
    const workers = [candidate("sonnet"), candidate("opus"), candidate("n120"), candidate("n550")];
    const b = await base(workers);
    const request: InferencePlanRequest = {
      topology: "cascade",
      governed: { tokens: 4_000 },
      width: 3,
    };
    expect(JSON.stringify(plan(workers, b, request))).toBe(
      JSON.stringify(plan(workers, b, request)),
    );
  });

  it("every plan states the telemetry a run of it must produce", async () => {
    const workers = [candidate("sonnet")];
    const p = expectPlan(
      plan(workers, await base(workers), { topology: "single", governed: NO_CEILINGS }),
    );
    expect(p.evidenceRequired.join(" ")).toMatch(/ROUTING_DECISION per stage/);
    expect(p.evidenceRequired.join(" ")).toMatch(/tokenUsage per stage/);
    expect(p.evidenceRequired.join(" ")).toMatch(/UNPRICED/);
  });

  it("a plan request cannot name a provider or a model", () => {
    /*
     * The run-time half only inspects a literal this test wrote, so it proves nothing on its own;
     * the `@ts-expect-error` is the assertion that carries weight, and it fails the BUILD if the
     * field ever becomes expressible. Kept together deliberately, and labelled as such.
     */
    const request: InferencePlanRequest = { topology: "single", governed: NO_CEILINGS };
    expect(Object.keys(request)).not.toContain("provider");
    // @ts-expect-error — naming a provider is unexpressible, not merely refused.
    const bypass: InferencePlanRequest = { ...request, provider: "privileged" };
    void bypass;
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Regression proofs. Each one FAILED at 6f07058 and was found by independent review.          */
/* ------------------------------------------------------------------------------------------ */

describe("inference plan — the plan never overrules the router", () => {
  it("across every topology, only a router-selectable worker is ever seated", async () => {
    /* One healthy worker; every other fails a different canonical gate. */
    const workers = [
      candidate("n120"),
      candidate("sonnet", { health: "degraded" }),
      candidate("opus", { availability: "unavailable" }),
      candidate("n550", { lastProbeAt: null, lastProbeOutcome: "never" }),
      candidate("sol", { runtimeSupport: "DECLARED_ONLY" }),
      candidate("haiku", { status: "inactive" }),
    ];
    const b = await base(workers);
    for (const topology of INFERENCE_TOPOLOGIES) {
      if (topology === "mission-specific") continue;
      const outcome = plan(workers, b, { topology, governed: NO_CEILINGS, width: 8 });
      if (!isPlan(outcome)) continue;
      for (const stage of outcome.stages) {
        for (const c of stage.candidates) {
          expect(c.workerId, `${topology} seated an ineligible worker`).toBe(id("n120"));
        }
      }
    }
  });

  it("the router's TIER_FALLBACK is RESPECTED and recorded, not overruled", async () => {
    /*
     * `rankComputePool` sets `selectable: true` while LEAVING `BELOW_REQUIRED_TIER` in
     * `exclusions` — "nothing meets the tier, this is the strongest that remains, and it is
     * recorded". Reading the exclusion list made the plan refuse where a bare dispatch would run.
     */
    /*
     * The relaxation needs a fleet whose top tier is out of reach for a transient reason: the
     * required tier is capped at the highest tier ELIGIBLE now (0054), so a single low-tier
     * worker never triggers it. Here n550 (tier 4) raises the cap and is then in cooldown, so
     * nothing meets tier 3 and haiku (tier 1) is promoted.
     */
    const workers = [candidate("haiku"), candidate("n550")];
    const history: ComputeOutcome[] = [
      {
        workerId: id("n550"),
        taskId: "t1",
        attempt: 1,
        state: "failed",
        failureClass: "RATE_LIMITED",
        at: ago(30_000),
      },
    ];
    const p = expectPlan(
      plan(workers, await base(workers, { complexity: "high", history }), {
        topology: "single",
        governed: NO_CEILINGS,
      }),
    );
    expect(p.stages[0]!.candidates[0]!.workerId).toBe(id("haiku"));
    expect(p.stages[0]!.candidates[0]!.routerFallback).toBe("TIER_FALLBACK");
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("PROVIDER_COOLDOWN");
  });
});

describe("inference plan — a ceiling that is not a number cannot widen one", () => {
  const widened = (requested: Record<string, number>) =>
    effectiveCeilings({ tokens: 8, latencyMs: 1_000, moneyMicros: 50 }, requested).ceilings;

  it("NaN loses the minimum instead of winning it", () => {
    /* `NaN >= g` is false, so `requested` won and every later comparison against NaN was false. */
    expect(widened({ tokens: NaN })).toMatchObject({ tokens: 8 });
    expect(widened({ latencyMs: NaN })).toMatchObject({ latencyMs: 1_000 });
    expect(effectiveCeilings({}, { tokens: NaN }).ceilings.tokens).toBeUndefined();
    expect(effectiveCeilings({}, { tokens: NaN }).sources.tokens).toBe("unset");
  });

  it("zero, negatives and Infinity are not ceilings", () => {
    expect(widened({ tokens: 0 })).toMatchObject({ tokens: 8 });
    expect(widened({ tokens: -1 })).toMatchObject({ tokens: 8 });
    expect(widened({ tokens: Infinity })).toMatchObject({ tokens: 8 });
    expect(effectiveCeilings({ tokens: 0 }, {}).ceilings.tokens).toBeUndefined();
  });

  it("a NaN ceiling can no longer reach a candidate gate", async () => {
    const workers = [candidate("sonnet"), candidate("n120")];
    const history: ComputeOutcome[] = [
      { workerId: id("sonnet"), taskId: "t1", attempt: 1, state: "completed", durationMs: 900_000, at: ago(60_000) },
    ];
    const p = expectPlan(
      plan(workers, await base(workers, { history }), {
        topology: "fallback",
        governed: { latencyMs: 1_000 },
        requested: { latencyMs: NaN },
        width: 2,
      }),
    );
    expect(p.ceilings.latencyMs).toBe(1_000);
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).not.toContain(id("sonnet"));
  });
});

describe("inference plan — independence covers EVERY writer candidate", () => {
  /*
   * `writerModel ??= kept[0]?.candidate.model` compared a judge only against the FIRST writer
   * candidate, while a producing stage's default width is 2. Measured at the shipped defaults:
   * writers [sonnet, nemotron-3-ultra-550b], judge oc/nemotron-3-ultra-free — the same effective
   * model as writer #2 — seated, with `independence: "required"` recorded on the plan.
   */
  const twoRoutesPlusOne = () => [candidate("sonnet"), candidate("n550"), candidate("n550alt")];

  it("a judge matching writer candidate #2 is refused at the DEFAULT width", async () => {
    const workers = twoRoutesPlusOne();
    const r = expectRefusal(
      plan(workers, await base(workers), { topology: "reviewer", governed: NO_CEILINGS }),
    );
    expect(r.purpose).toBe("review");
    expect(r.refused.flatMap((x) => x.because)).toContain("NOT_INDEPENDENT_OF_WRITER");
  });

  it("same for critique, whose critic judges the same work", async () => {
    const workers = twoRoutesPlusOne();
    const r = expectRefusal(
      plan(workers, await base(workers), { topology: "critique", governed: NO_CEILINGS }),
    );
    expect(r.purpose).toBe("critique");
    expect(r.refused.flatMap((x) => x.because)).toContain("NOT_INDEPENDENT_OF_WRITER");
  });

  it("an UNPROVABLE independence refuses instead of passing unchecked", async () => {
    /*
     * A writer declaring no model skipped the check AND left the router's gate off, so a plan
     * recorded `independence: "required"` while nothing had been verified and no refusal said so.
     */
    const workers = [modelless("sonnet"), candidate("opus")];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "reviewer",
        governed: NO_CEILINGS,
        width: 1,
      }),
    );
    expect(r.refused.flatMap((x) => x.because)).toContain("INDEPENDENCE_UNVERIFIABLE");
  });

  it("a judge declaring no model is refused too", async () => {
    const workers = [candidate("sonnet"), modelless("opus")];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "reviewer",
        governed: NO_CEILINGS,
        width: 1,
      }),
    );
    expect(r.refused.flatMap((x) => x.because)).toContain("INDEPENDENCE_UNVERIFIABLE");
  });

  it("mission-specific cannot declare a judge with nothing to judge", async () => {
    const workers = [candidate("sonnet"), candidate("opus")];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "mission-specific",
        governed: NO_CEILINGS,
        stages: [
          { role: "reviewer", purpose: "review" },
          { role: "writer", purpose: "produce" },
        ],
      }),
    );
    expect(r.reason).toMatch(/juge sans étape productrice/);
  });

  it("mission-specific cannot give a writer a judging purpose, or the reverse", async () => {
    const workers = [candidate("sonnet")];
    const b = await base(workers);
    for (const stage of [
      { role: "writer" as const, purpose: "aggregate" as const },
      { role: "reviewer" as const, purpose: "produce" as const },
    ]) {
      expect(
        expectRefusal(
          plan(workers, b, { topology: "mission-specific", governed: NO_CEILINGS, stages: [stage] }),
        ).reason,
      ).toMatch(/incompatible/);
    }
  });
});

describe("inference plan — diversity means the same-judge rule", () => {
  it("two routes to one model, under names effectiveModelKey does not collapse, seat ONCE", async () => {
    const workers = [candidate("n550"), candidate("n550alt")];
    /* The keys differ; `sameEffectiveModel` is what says these are one model. */
    expect(effectiveModelKey(MODELS.n550)).not.toBe(effectiveModelKey(MODELS.n550alt));
    expect(sameEffectiveModel(MODELS.n550, MODELS.n550alt)).toBe(true);

    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "fallback",
        governed: NO_CEILINGS,
        diversity: "distinct-model",
        width: 2,
      }),
    );
    expect(p.stages[0]!.candidates).toHaveLength(1);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("DUPLICATE_MODEL");
  });

  it("a candidate declaring no model cannot be claimed distinct", async () => {
    const workers = [modelless("sonnet"), modelless("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "fallback",
        governed: NO_CEILINGS,
        diversity: "distinct-model",
        width: 2,
      }),
    );
    expect(p.stages[0]!.candidates).toHaveLength(1);
    expect(p.stages[0]!.refused.flatMap((r) => r.because)).toContain("INDEPENDENCE_UNVERIFIABLE");
  });

  it("a REFUSED candidate does not consume a diversity seat", async () => {
    /*
     * Measured: an `unhealthy` route sorted first under latency-first, took the seat, and the
     * HEALTHY route to the same model was dropped as a duplicate. The refused one was never
     * going to run, so it cost the stage its only viable member.
     */
    const workers = [
      candidate("n550alt", { health: "unhealthy" }),
      candidate("n550"),
    ];
    const history: ComputeOutcome[] = [
      { workerId: id("n550alt"), taskId: "t1", attempt: 1, state: "completed", durationMs: 1_000, at: ago(60_000) },
      { workerId: id("n550"), taskId: "t2", attempt: 1, state: "completed", durationMs: 9_000, at: ago(60_000) },
    ];
    const p = expectPlan(
      plan(workers, await base(workers, { history }), {
        topology: "latency-first",
        governed: NO_CEILINGS,
        diversity: "distinct-model",
        width: 2,
      }),
    );
    expect(p.stages[0]!.candidates.map((c) => c.workerId)).toEqual([id("n550")]);
  });
});

describe("inference plan — the worst case needs no unproven assumption", () => {
  it("it charges the DEARER rate, not the completion rate", async () => {
    /*
     * The justification was "the completion rate, which is never below the prompt rate". Nothing
     * enforces that: `recordDefect` only requires both rates positive. A record with a prompt
     * rate ten million times the completion rate validated, and a candidate was admitted under a
     * 5-micro enforced ceiling with a "worst case" of 1 micro.
     */
    const workers = [candidate("n120")];
    const lopsided: PriceRegistry = [
      {
        provider: "nvidia",
        modelId: MODELS.n120,
        currency: "EUR",
        promptMicrosPerMillion: 10 * MICROS_PER_UNIT,
        completionMicrosPerMillion: 1,
        provenance: "fixture de test, pas un tarif réel",
        effectiveAt: "2026-10-01T00:00:00.000Z",
        staleAfter: "2026-12-01T00:00:00.000Z",
      },
    ];
    const b = await base(workers);
    const governed = { tokens: 1_000, moneyMicros: 5, moneyEnforced: true };
    expect(
      expectRefusal(plan(workers, b, { topology: "single", governed }, lopsided)).refused[0]!
        .because,
    ).toContain("MONEY_CEILING_EXCEEDED");
    /* And the number it reports is the real worst case: 1 000 tokens at 10 EUR/Mtok. */
    const p = expectPlan(
      plan(workers, b, { topology: "single", governed: { tokens: 1_000 } }, lopsided),
    );
    expect(p.stages[0]!.candidates[0]!.worstCaseCostMicros).toBe(10_000);
  });
});

describe("inference plan — a refusal points at what actually refused it", () => {
  it("costUnprovableBecause appears ONLY on a refusal the cost caused", async () => {
    /*
     * It was attached to every refusal, so a candidate excluded as the writer's own worker
     * carried "no token ceiling" beside it — sending an operator to the price registry over a
     * review-independence rule, the exact failure this field was added to prevent.
     */
    const workers = [candidate("sonnet"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers), {
        topology: "reviewer",
        governed: NO_CEILINGS,
        width: 1,
      }),
    );
    const judgeRefusals = p.stages[1]!.refused;
    expect(judgeRefusals.flatMap((r) => r.because)).toContain("EXCLUDED_WORKER");
    for (const r of judgeRefusals) {
      if (!r.because.includes("COST_UNPROVABLE")) {
        expect(r.costUnprovableBecause).toBeUndefined();
      }
    }
  });

  it("every stage of a cascade carries the refusals, not only the first", async () => {
    const workers = [
      candidate("haiku"),
      candidate("sonnet"),
      candidate("opus"),
      candidate("n120", { health: "unhealthy" }),
    ];
    const p = expectPlan(
      plan(workers, await base(workers, { complexity: "low" }), {
        topology: "cascade",
        governed: NO_CEILINGS,
      }),
    );
    expect(p.stages.length).toBeGreaterThan(1);
    for (const stage of p.stages) {
      expect(stage.refused.flatMap((r) => r.because)).toContain("HEALTH_NOT_HEALTHY");
    }
  });
});

describe("inference plan — shape coherence", () => {
  it("the plan authors no retry budget: one attempt per declared candidate", async () => {
    const workers = [candidate("sonnet"), candidate("opus"), candidate("n120")];
    const b = await base(workers);
    const single = expectPlan(plan(workers, b, { topology: "single", governed: NO_CEILINGS }));
    /* `single`'s own doc says a failure is the task's failure. It used to ship two attempts. */
    expect(single.stages[0]!.maxAttempts).toBe(1);
    const multi = expectPlan(
      plan(workers, b, { topology: "fallback", governed: NO_CEILINGS, width: 3 }),
    );
    for (const stage of multi.stages) {
      expect(stage.maxAttempts).toBe(stage.candidates.length);
    }
  });

  it("an ensemble that cannot seat two distinct judges refuses, never degrades silently", async () => {
    const workers = [candidate("n550"), candidate("n550alt")];
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "ensemble",
        governed: NO_CEILINGS,
        width: 2,
      }),
    );
    expect(r.purpose).toBe("member");
    expect(r.reason).toMatch(/au moins 2/);
  });

  it("a cascade that advances on a review verdict can also terminate on one", async () => {
    const workers = [candidate("haiku"), candidate("opus")];
    const p = expectPlan(
      plan(workers, await base(workers, { complexity: "low" }), {
        topology: "cascade",
        governed: NO_CEILINGS,
      }),
    );
    expect(p.stages[0]!.advanceWhen).toContain("REVIEW_REQUEST_CHANGES");
    expect(p.terminateWhen).toContain("REVIEW_APPROVED");
  });
});

describe("inference plan — second falsifier: defaults and edge cases", () => {
  /* Writers [sonnet, nemotron-3-ultra-550b]; the only remaining judge is a second route to n550. */
  const twoRoutesPlusOne = () => [candidate("sonnet"), candidate("n550"), candidate("n550alt")];

  it("a mission-specific review defaults to REQUIRED independence, like the reviewer topology", async () => {
    const workers = twoRoutesPlusOne();
    const r = expectRefusal(
      plan(workers, await base(workers), {
        topology: "mission-specific",
        governed: NO_CEILINGS,
        stages: [
          { role: "writer", purpose: "produce" },
          { role: "reviewer", purpose: "review" },
        ],
      }),
    );
    expect(r.purpose).toBe("review");
    expect(r.refused.flatMap((x) => x.because)).toContain("NOT_INDEPENDENT_OF_WRITER");
  });

  it("the ensemble aggregation is independent of every member by default", async () => {
    const workers = twoRoutesPlusOne();
    const r = expectRefusal(
      plan(workers, await base(workers), { topology: "ensemble", governed: NO_CEILINGS }),
    );
    expect(r.purpose).toBe("aggregate");
    expect(r.refused.flatMap((x) => x.because)).toContain("NOT_INDEPENDENT_OF_WRITER");

    const fleet = [candidate("sonnet"), candidate("n550"), candidate("sol"), candidate("opus")];
    const p = expectPlan(
      plan(fleet, await base(fleet), { topology: "ensemble", governed: NO_CEILINGS }),
    );
    expect(p.independence).toBe("required");
    const members = p.stages[0]!.candidates.map((c) => c.model!);
    const judge = p.stages[1]!.candidates[0]!.model!;
    expect(members.some((m) => sameEffectiveModel(m, judge))).toBe(false);
  });

  it("a plan with no judging stage keeps the router's preference", async () => {
    const workers = [candidate("sonnet"), candidate("n120")];
    const p = expectPlan(
      plan(workers, await base(workers), { topology: "fallback", governed: NO_CEILINGS }),
    );
    expect(p.independence).toBe("preferred");
  });

  it("a fractional token ceiling is floored, so a KNOWN price still meets the money ceiling", async () => {
    const workers = [candidate("n120")];
    const prices: PriceRegistry = [
      {
        provider: "nvidia",
        modelId: "nvidia/nemotron-3-super-120b",
        currency: "EUR",
        promptMicrosPerMillion: 3 * MICROS_PER_UNIT,
        completionMicrosPerMillion: 3 * MICROS_PER_UNIT,
        provenance: "fixture de test, pas un tarif réel",
        effectiveAt: "2026-10-01T00:00:00.000Z",
        staleAfter: "2026-12-01T00:00:00.000Z",
      },
    ];
    const r = expectRefusal(
      plan(
        workers,
        await base(workers),
        { topology: "single", governed: { tokens: 1_000.5, moneyMicros: 10 } },
        prices,
      ),
    );
    expect(r.ceilings.tokens).toBe(1_000);
    expect(r.refused[0]!.because).toContain("MONEY_CEILING_EXCEEDED");
  });

  it("a token ceiling below one whole token is no ceiling, on either side", () => {
    expect(effectiveCeilings({ tokens: 0.5 }).ceilings.tokens).toBeUndefined();
    expect(effectiveCeilings({ tokens: 100 }, { tokens: 99.9 }).ceilings.tokens).toBe(99);
  });
});
