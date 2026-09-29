import { describe, expect, it } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerFailureClass } from "@/core/contracts/worker-execution";
import {
  aggregateHistory,
  budgetFitsLease,
  computeProfileOf,
  effectiveModelKey,
  normalizeFailure,
  sameEffectiveModel,
  reviewerEffectiveIdentity,
  writerEffectiveModel,
  requiredTier,
  COMPUTE_POLICY_VERSION,
  SETTLEMENT_MARGIN_MS,
  type ComputeOutcome,
  type PriorAttemptFact,
} from "@/core/workers/compute-routing";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { CapabilityRouter, type ComputeRequest } from "@/server/routing/capability-router";
import {
  candidateRegistration,
  candidateWorkerId,
  classifyModels,
  classifyProbeFailure,
  representativeModels,
} from "@/server/workers/compute-fleet";

/*
 * GOVERNED COMPUTE ROUTING — decision 0054.
 *
 * Every proof goes through the REAL CapabilityRouter over the canonical eligibility authority:
 * there is no second router to test. Model ids are fixtures; the policy only ever sees them
 * through family recognition, never by name.
 */

const NOW = new Date("2026-09-29T12:00:00.000Z");
const PROBED = new Date(NOW.getTime() - 10_000).toISOString();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MODELS = {
  haiku: "anthropic/claude-haiku-4-5",
  n120: "nvidia/nemotron-3-super-120b",
  sonnet: "anthropic/claude-sonnet-5",
  sol: "openai/gpt-5.6-sol",
  n550: "nvidia/nemotron-ultra-550b",
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

function router(
  workers: WorkerRegistryEntry[],
  opts: { history?: ComputeOutcome[]; leaseMs?: number; defaultBudgetMs?: number } = {},
) {
  return new CapabilityRouter(new InMemoryWorkerRegistryStore(workers), {
    now: () => NOW,
    computeHistory: async () => opts.history ?? [],
    executionLeaseMs: opts.leaseMs ?? 25 * 60_000,
    defaultBudgetMs: () => opts.defaultBudgetMs ?? 15 * 60_000,
    steersModel: () => true,
  });
}

function writer(over: Partial<ComputeRequest> = {}): ComputeRequest {
  return {
    role: "writer",
    complexity: "medium",
    repositoryMutation: true,
    correctionAttempt: 0,
    priorAttempts: [],
    ...over,
  };
}

const ALL: Key[] = ["haiku", "n120", "sonnet", "sol", "n550", "opus"];
const fleet = (keys: Key[] = ALL, over: Partial<Record<Key, Partial<WorkerRegistryEntry>>> = {}) =>
  keys.map((k) => candidate(k, over[k]));

function outcomes(
  key: Key,
  n: number,
  shape: {
    failureClass?: WorkerFailureClass;
    reviewVerdict?: string;
    attempt?: number;
    at?: string;
  },
): ComputeOutcome[] {
  return Array.from({ length: n }, (_, i) => ({
    workerId: id(key),
    taskId: `hist-${key}-${i}`,
    attempt: shape.attempt ?? 1,
    state: shape.failureClass ? "failed" : "completed",
    failureClass: shape.failureClass,
    reviewVerdict: shape.reviewVerdict,
    at: shape.at ?? ago(60 * 60_000 + i),
  }));
}

const selectedFamily = async (
  r: CapabilityRouter,
  req: ComputeRequest,
  caps = ["code_editing"],
) => {
  const result = await r.route({ requiredCapabilities: caps }, req);
  return { result, family: result.worker ? computeProfileOf(result.worker).family : null };
};

describe("decision 0054 — the six logical families", () => {
  it("every family is representable, recognised from provider ids, with UNKNOWN left unknown", () => {
    const classified = classifyModels([
      ...Object.values(MODELS),
      "auto/best-coding",
      "mistral/large",
    ]);
    expect(classified.map((c) => c.family).sort()).toEqual([
      "CLAUDE_HAIKU",
      "CLAUDE_OPUS",
      "CLAUDE_SONNET",
      "GPT_SOL",
      "NEMOTRON_120B",
      "NEMOTRON_550B",
    ]);
    /* A model with no recognised family has no tier and no cost — not a guessed one. */
    const unknown = computeProfileOf(
      candidate("sonnet", { metadata: { model: "mistral/large", modelFamily: "" } }),
    );
    expect(unknown.family).toBeUndefined();
    expect(unknown.tier).toBeUndefined();
  });
});

describe("decision 0054 — routing policy (Phase 12 proofs)", () => {
  it("1. a simple task selects an eligible low-cost candidate", async () => {
    const { family } = await selectedFamily(
      router(fleet()),
      writer({ complexity: "low", repositoryMutation: false }),
    );
    expect(["CLAUDE_HAIKU", "NEMOTRON_120B"]).toContain(family);
  });

  it("2. a complex task EXCLUDES incapable candidates, and says so", async () => {
    const { result, family } = await selectedFamily(
      router(fleet()),
      writer({ complexity: "high", correctionAttempt: 2 }),
    );
    expect(["GPT_SOL", "NEMOTRON_550B", "CLAUDE_OPUS"]).toContain(family);
    const haiku = result.evidence!.candidateSet.find((c) => c.workerId === id("haiku"))!;
    expect(haiku.selectable).toBe(false);
    expect(haiku.excludedBecause).toContain("BELOW_REQUIRED_TIER");
  });

  it("3. an unhealthy candidate is excluded", async () => {
    const r = router(fleet(["n120", "sonnet"], { n120: { health: "unhealthy" } }));
    const { result } = await selectedFamily(r, writer({ complexity: "low" }));
    expect(result.worker?.id).toBe(id("sonnet"));
    expect(
      result.evidence!.candidateSet.find((c) => c.workerId === id("n120"))!.excludedBecause,
    ).toContain("HEALTH_NOT_HEALTHY");
  });

  it("4. an unavailable model is excluded", async () => {
    const r = router(fleet(["sonnet", "sol"], { sonnet: { availability: "unavailable" } }));
    const { result } = await selectedFamily(r, writer());
    expect(result.worker?.id).toBe(id("sol"));
  });

  it("5. a rate-limited PROVIDER is excluded for its cooldown — every model behind it — then returns", async () => {
    const limited = outcomes("sonnet", 1, { failureClass: "RATE_LIMITED", at: ago(60_000) });
    const r = router(fleet(["sonnet", "opus", "n550"]), { history: limited });
    const { result } = await selectedFamily(r, writer({ complexity: "high" }));
    /* Opus shares Sonnet's provider account: throttled too. */
    expect(result.worker?.id).toBe(id("n550"));
    for (const k of ["sonnet", "opus"] as const) {
      expect(
        result.evidence!.candidateSet.find((c) => c.workerId === id(k))!.excludedBecause,
      ).toContain("PROVIDER_COOLDOWN");
    }
    const later = router(fleet(["sonnet", "opus", "n550"]), {
      history: outcomes("sonnet", 1, { failureClass: "RATE_LIMITED", at: ago(10 * 60_000) }),
    });
    const after = await later.route(
      { requiredCapabilities: ["code_editing"] },
      writer({ complexity: "high" }),
    );
    expect(
      after.evidence!.candidateSet.every((c) => !c.excludedBecause.includes("PROVIDER_COOLDOWN")),
    ).toBe(true);
  });

  it("6. a model that TIMED OUT on this task is not chosen again for its retry when another fits", async () => {
    const prior: PriorAttemptFact[] = [
      { attempt: 1, workerId: id("sol"), failureClass: "EXECUTION_TIMEOUT" },
    ];
    const r = router(fleet(["sol", "n550", "opus"]));
    const first = await r.route(
      { requiredCapabilities: ["code_editing"] },
      writer({ complexity: "high" }),
    );
    const retry = await r.route(
      { requiredCapabilities: ["code_editing"] },
      writer({ complexity: "high", priorAttempts: prior }),
    );
    expect(retry.worker?.id).not.toBe(id("sol"));
    expect(retry.evidence!.escalationReason.join(" ")).toMatch(/EXECUTION_TIMEOUT/);
    const solScore = retry.evidence!.candidateSet.find((c) => c.workerId === id("sol"))!.score!;
    expect(solScore.priorFailurePenalty).toBeGreaterThan(0);
    expect(first.evidence!.previousFailure).toBeUndefined();
  });

  it("7. a model that CRASHED on this task is penalised for the retry", async () => {
    const prior: PriorAttemptFact[] = [
      { attempt: 1, workerId: id("sonnet"), failureClass: "WORKER_CRASHED" },
    ];
    const { result } = await selectedFamily(
      router(fleet(["sonnet", "sol"])),
      writer({ priorAttempts: prior }),
    );
    expect(result.worker?.id).toBe(id("sol"));
  });

  it("8. a second legitimate rejection escalates the model class", async () => {
    const r = router(fleet());
    const once = await selectedFamily(
      r,
      writer({
        correctionAttempt: 1,
        priorAttempts: [{ attempt: 1, workerId: id("sonnet"), reviewVerdict: "REQUEST_CHANGES" }],
      }),
    );
    const twice = await selectedFamily(
      r,
      writer({
        correctionAttempt: 2,
        priorAttempts: [
          { attempt: 1, workerId: id("sonnet"), reviewVerdict: "REQUEST_CHANGES" },
          { attempt: 2, workerId: id("n120"), reviewVerdict: "REQUEST_CHANGES" },
        ],
      }),
    );
    expect(twice.result.evidence!.requiredTier).toBeGreaterThan(once.result.evidence!.requiredTier);
    expect(["GPT_SOL", "NEMOTRON_550B", "CLAUDE_OPUS"]).toContain(twice.family);
    expect(twice.result.evidence!.escalationReason.join(" ")).toMatch(
      /2 legitimate reviewer rejections/,
    );
  });

  it("11/12. the reviewer is routed independently and never on the writer's own model when another qualifies", async () => {
    const r = router(fleet(["sonnet", "sol"]));
    const review = await r.route(
      { requiredCapabilities: ["review"], excludeWorkerIds: [] },
      {
        role: "reviewer",
        complexity: "medium",
        repositoryMutation: false,
        correctionAttempt: 0,
        priorAttempts: [],
        writerWorkerId: id("sonnet"),
      },
    );
    expect(review.worker?.id).toBe(id("sol"));
    expect(review.evidence!.role).toBe("reviewer");
    expect(
      review.evidence!.candidateSet.find((c) => c.workerId === id("sonnet"))!.excludedBecause,
    ).toContain("SAME_MODEL_AS_WRITER");
  });

  it("12b. with NO alternative, the same model may still review — independence is a preference, review is not optional", async () => {
    const r = router(fleet(["sonnet"]));
    const review = await r.route(
      { requiredCapabilities: ["review"] },
      {
        role: "reviewer",
        complexity: "medium",
        repositoryMutation: false,
        correctionAttempt: 0,
        priorAttempts: [],
        writerWorkerId: id("sonnet"),
      },
    );
    expect(review.worker?.id).toBe(id("sonnet"));
  });

  it("13. no viable candidate -> NO_ELIGIBLE_WORKER (fail closed), with evidence", async () => {
    const r = router(
      fleet(["n120", "sonnet"], {
        n120: { health: "unknown" },
        sonnet: { availability: "unknown" },
      }),
    );
    const result = await r.route({ requiredCapabilities: ["code_editing"] }, writer());
    expect(result.decision).toBe("NO_ELIGIBLE_WORKER");
    expect(result.worker).toBeNull();
    expect(result.evidence!.selected).toBeNull();
    expect(result.evidence!.candidateSet).toHaveLength(2);
  });

  it("14. a budget that cannot fit the lease is rejected, per candidate, by the one invariant", async () => {
    const lease = 20 * 60_000;
    expect(budgetFitsLease(lease - SETTLEMENT_MARGIN_MS, lease)).toBe(true);
    expect(budgetFitsLease(lease - SETTLEMENT_MARGIN_MS + 1, lease)).toBe(false);
    expect(budgetFitsLease(lease, lease)).toBe(false);

    const r = router(
      fleet(["sonnet", "sol"], { sol: { metadata: { executionBudgetMs: String(lease) } } }),
      { leaseMs: lease },
    );
    const result = await r.route(
      { requiredCapabilities: ["code_editing"] },
      writer({ complexity: "high" }),
    );
    expect(result.worker?.id).toBe(id("sonnet"));
    expect(
      result.evidence!.candidateSet.find((c) => c.workerId === id("sol"))!.excludedBecause,
    ).toContain("BUDGET_EXCEEDS_LEASE");
    expect(result.evidence!.budget).toMatchObject({ source: "runtime-default" });
    expect(result.evidence!.lease).toEqual({ ms: lease, settlementMarginMs: SETTLEMENT_MARGIN_MS });
  });

  it("14b. after a timeout, a DECLARED larger budget is used when it fits — and the reason is recorded", async () => {
    const r = router(
      fleet(["n550"], {
        n550: {
          metadata: {
            executionBudgetMs: String(15 * 60_000),
            maxExecutionBudgetMs: String(22 * 60_000),
          },
        },
      }),
      { leaseMs: 25 * 60_000 },
    );
    const result = await r.route(
      { requiredCapabilities: ["code_editing"] },
      writer({
        priorAttempts: [{ attempt: 1, workerId: "gone", failureClass: "EXECUTION_TIMEOUT" }],
      }),
    );
    expect(result.evidence!.budget).toMatchObject({
      ms: 22 * 60_000,
      source: "escalated-after-timeout",
    });
  });

  it("15. history moves selection: a reliable, approved model overtakes an equal-prior one", async () => {
    const base = await selectedFamily(
      router(fleet(["sol", "n550"])),
      writer({ complexity: "high" }),
    );
    const history = [
      ...outcomes(base.family === "GPT_SOL" ? "sol" : "n550", 12, {
        failureClass: "EXECUTION_TIMEOUT",
      }),
      ...outcomes(base.family === "GPT_SOL" ? "n550" : "sol", 12, { reviewVerdict: "APPROVE" }),
    ];
    const learned = await selectedFamily(
      router(fleet(["sol", "n550"]), { history }),
      writer({ complexity: "high" }),
    );
    expect(learned.family).not.toBe(base.family);
  });

  it("15b. infrastructure failures ALONE move selection (reliability), with no review signal", async () => {
    const base = await selectedFamily(
      router(fleet(["sol", "n550"])),
      writer({ complexity: "high" }),
    );
    const loser = base.family === "GPT_SOL" ? "sol" : "n550";
    const history = outcomes(loser, 12, { failureClass: "EXECUTION_TIMEOUT" });
    const learned = await selectedFamily(
      router(fleet(["sol", "n550"]), { history }),
      writer({ complexity: "high" }),
    );
    expect(learned.family).not.toBe(base.family);
    const hurt = learned.result.evidence!.candidateSet.find((c) => c.workerId === id(loser))!;
    expect(hurt.history).toMatchObject({ executions: 12, infraFailures: 12, timeouts: 12 });
  });

  it("B1. a refusal-class failure (429) never blocks: a cooldown-only refusal is TRANSIENT back-pressure", async () => {
    const limited = outcomes("sonnet", 1, { failureClass: "RATE_LIMITED", at: ago(60_000) });
    const result = await router(fleet(["sonnet", "opus"]), { history: limited }).route(
      { requiredCapabilities: ["code_editing"] },
      writer(),
    );
    expect(result.decision).toBe("NO_ELIGIBLE_WORKER");
    expect(result.transient).toBe(true);
    const unhealthy = await router(fleet(["sonnet"], { sonnet: { health: "unhealthy" } })).route(
      { requiredCapabilities: ["code_editing"] },
      writer(),
    );
    expect(unhealthy.transient).toBe(false);
  });

  it("N1. a fleet that cannot meet the tier still routes: the requirement is CAPPED at what exists, and says so", async () => {
    const result = await router(fleet(["haiku", "n120"])).route(
      { requiredCapabilities: ["code_editing"] },
      writer({ complexity: "high", correctionAttempt: 2 }),
    );
    expect(result.decision).toBe("ROUTED");
    expect(result.worker?.id).toBe(id("n120"));
    expect(result.evidence!.requiredTier).toBe(2);
    expect(result.evidence!.escalationReason.join(" ")).toMatch(/capped at 2/);
  });

  it("16. one bad result does not blacklist; a cold-start model scores its prior and stays selectable", async () => {
    const history = outcomes("sonnet", 1, { failureClass: "EXECUTION_TIMEOUT" });
    const result = await router(fleet(["sonnet"]), { history }).route(
      { requiredCapabilities: ["code_editing"] },
      writer(),
    );
    expect(result.worker?.id).toBe(id("sonnet"));
    const cold = await router(fleet(["opus"])).route(
      { requiredCapabilities: ["code_editing"] },
      writer(),
    );
    const s = cold.evidence!.candidateSet[0]!.score!;
    expect(s.reliability).toBeCloseTo(0.8);
    expect(s.quality).toBeCloseTo(0.5);
    const hurt = result.evidence!.candidateSet[0]!.score!;
    expect(hurt.reliability).toBeGreaterThan(0.6);
  });

  it("19. every decision is auditable: policy version, candidate set, reasons, scores, selection", async () => {
    const result = await router(fleet()).route(
      { requiredCapabilities: ["code_editing"] },
      writer(),
    );
    const e = result.evidence!;
    expect(e.kind).toBe("ROUTING_DECISION");
    expect(e.policyVersion).toBe(COMPUTE_POLICY_VERSION);
    expect(e.decidedAt).toBe(NOW.toISOString());
    expect(e.candidateSet).toHaveLength(6);
    expect(e.selected?.workerId).toBe(result.worker?.id);
    expect(e.selected?.modelSteered).toBe(true);
    expect(e.candidateSet[0]!.workerId).toBe(result.worker?.id);
    /* JSON-safe: it is persisted as-is. No credential field exists to leak. */
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    expect(JSON.stringify(e)).not.toMatch(/key|token|secret|credential/i);
  });

  it("DETERMINISTIC: the same rows, clock and policy give the same decision", async () => {
    const history = [
      ...outcomes("sonnet", 3, { reviewVerdict: "APPROVE" }),
      ...outcomes("n120", 2, { failureClass: "WORKER_CRASHED" }),
    ];
    const a = await router(fleet(), { history }).route(
      { requiredCapabilities: ["code_editing"] },
      writer(),
    );
    const b = await router([...fleet()].reverse(), { history: [...history].reverse() }).route(
      { requiredCapabilities: ["code_editing"] },
      writer(),
    );
    expect(b.evidence).toEqual(a.evidence);
  });

  it("NO COMPUTE REQUIREMENT = the pre-0054 behaviour exactly (least load, then id)", async () => {
    const result = await router(fleet()).route({ requiredCapabilities: ["code_editing"] });
    expect(result.evidence).toBeUndefined();
    expect(result.worker?.id).toBe([...ALL.map(id)].sort()[0]);
  });
});

describe("decision 0054 — escalation and history are bounded", () => {
  it("required tier is capped, and grows only from ledger facts", () => {
    const req = {
      role: "writer" as const,
      complexity: "high" as const,
      repositoryMutation: true,
      correctionAttempt: 5,
      priorAttempts: [{ attempt: 3, failureClass: "EXECUTION_TIMEOUT" as const }],
    };
    expect(requiredTier(req).tier).toBe(6);
    expect(requiredTier({ ...req, correctionAttempt: 0, priorAttempts: [] }).tier).toBe(3);
  });

  it("history outside the window does not count", () => {
    const old = outcomes("sonnet", 5, {
      failureClass: "EXECUTION_TIMEOUT",
      at: ago(30 * 24 * 60 * 60_000),
    });
    const h = aggregateHistory(old, () => "k", NOW.toISOString());
    expect(h.size).toBe(0);
  });
});

describe("decision 0054 — normalized failure classes drive policy", () => {
  it("maps the ledger's classes onto the routing vocabulary; review and gate outcomes are not infrastructure", () => {
    expect(normalizeFailure({ failureClass: "EXECUTION_TIMEOUT" })).toBe("EXECUTION_TIMEOUT");
    expect(normalizeFailure({ failureClass: "RATE_LIMITED" })).toBe("RATE_LIMIT");
    expect(normalizeFailure({ failureClass: "AUTH_FAILURE" })).toBe("AUTH_OR_CREDENTIAL_FAILURE");
    expect(normalizeFailure({ failureClass: "MODEL_UNAVAILABLE" })).toBe("MODEL_UNAVAILABLE");
    expect(normalizeFailure({ failureClass: "WORKER_CRASHED" })).toBe("WORKER_CRASH");
    expect(normalizeFailure({ failureClass: "STREAM_FAILED" })).toBe("TRANSIENT_PROVIDER_ERROR");
    expect(normalizeFailure({ failureClass: "LEASE_EXPIRED" })).toBe("LEASE_EXPIRED");
    expect(normalizeFailure({ ownershipLost: true, failureClass: "LEASE_EXPIRED" })).toBe(
      "OWNERSHIP_LOST",
    );
    expect(normalizeFailure({ failureClass: "FAILED_TERMINAL" })).toBe("TASK_LOGIC_FAILURE");
    expect(normalizeFailure({ failureClass: "FAILED_RETRYABLE" })).toBe("UNKNOWN");
    expect(normalizeFailure({ reviewVerdict: "REQUEST_CHANGES" })).toBe("REVIEW_REQUEST_CHANGES");
    expect(normalizeFailure({ gateFailed: true })).toBe("REPOSITORY_GATE_FAILURE");
    expect(normalizeFailure({ reviewVerdict: "APPROVE" })).toBeUndefined();
  });

  it("a verdict on a FAILED execution is not a quality signal (no double charge for one infra failure)", () => {
    const h = aggregateHistory(
      outcomes("sonnet", 3, { failureClass: "EXECUTION_TIMEOUT", reviewVerdict: "RETRY" }),
      () => "k",
      NOW.toISOString(),
    ).get("k")!;
    expect(h.infraFailures).toBe(3);
    expect(h.reviewed).toBe(0);
  });

  it("a legitimate REQUEST_CHANGES never counts against reliability — only against quality", () => {
    const h = aggregateHistory(
      outcomes("sonnet", 4, { reviewVerdict: "REQUEST_CHANGES" }),
      () => "k",
      NOW.toISOString(),
    ).get("k")!;
    expect(h.infraFailures).toBe(0);
    expect(h.reviewed).toBe(4);
    expect(h.firstPassApprovals).toBe(0);
  });
});

describe("decision 0054 live certification — identity and inventory", () => {
  it("recognises Nemotron 3 only: llama-nemotron 49B/253B are NOT the 120B/550B families", () => {
    const got = classifyModels([
      "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1",
      "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "nvidia/nvidia/nemotron-3-super-120b-a12b",
      "oc/nemotron-3-ultra-free",
    ]).map((d) => [d.modelId, d.family]);
    expect(got).toEqual([
      ["nvidia/nvidia/nemotron-3-super-120b-a12b", "NEMOTRON_120B"],
      ["oc/nemotron-3-ultra-free", "NEMOTRON_550B"],
    ]);
  });

  it("one representative per (family, provider): newest base id, no effort variants or wrappers", () => {
    const reps = representativeModels(
      classifyModels([
        "cc/claude-sonnet-4-6",
        "cc/claude-sonnet-5",
        "cc/claude-sonnet-5-high",
        "no-think/cc/claude-sonnet-5",
        "claude/claude-sonnet-5",
        "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        "openrouter/nvidia/nemotron-3-super-120b-a12b:free-high",
      ]),
    ).map((d) => d.modelId);
    expect(reps).toEqual([
      "cc/claude-sonnet-5",
      "claude/claude-sonnet-5",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    ]);
  });

  it("probe failures classify factually; a timeout or unknown text is never AVAILABLE", () => {
    expect(classifyProbeFailure("HTTP 404: No active credentials for provider: bogus")).toBe(
      "NOT_CONFIGURED",
    );
    expect(classifyProbeFailure("HTTP 401: [401]: Model oc/x is not supported")).toBe(
      "AUTH_FAILURE",
    );
    expect(classifyProbeFailure("HTTP 403: credits exhausted")).toBe("AUTH_FAILURE");
    expect(
      classifyProbeFailure("HTTP 429: All codex accounts reached configured quota threshold"),
    ).toBe("RATE_LIMITED");
    expect(classifyProbeFailure("WORKER_PROBE_TIMEOUT: hermes did not answer")).toBe("UNKNOWN");
  });

  it("effective identity: same model across accounts/variants; unsteered or command-binary = UNKNOWN", () => {
    expect(effectiveModelKey("cc/claude-sonnet-5-high")).toBe(
      effectiveModelKey("claude/claude-sonnet-5"),
    );
    expect(effectiveModelKey("openrouter/nvidia/nemotron-3-super-120b-a12b:free")).toBe(
      effectiveModelKey("nvidia/nvidia/nemotron-3-super-120b-a12b"),
    );
    expect(effectiveModelKey("cc/claude-opus-5")).not.toBe(effectiveModelKey("cc/claude-sonnet-5"));

    expect(
      writerEffectiveModel({ selected: { model: "cc/claude-sonnet-5", modelSteered: true } }),
    ).toBe("cc/claude-sonnet-5");
    expect(
      writerEffectiveModel({ selected: { model: "cc/claude-sonnet-5", modelSteered: false } }),
    ).toBeUndefined();
    expect(writerEffectiveModel({ selected: { model: "cc/claude-sonnet-5" } })).toBeUndefined();

    expect(
      reviewerEffectiveIdentity({
        provider: "cc",
        model: "cc/claude-opus-5",
        routing: { selected: { workerId: "w2" } },
      }),
    ).toEqual({ workerId: "w2", model: "cc/claude-opus-5" });
    expect(reviewerEffectiveIdentity({ provider: "omniroute", model: "gpt-x" })).toEqual({
      workerId: undefined,
      model: "gpt-x",
    });
    expect(reviewerEffectiveIdentity({ provider: "command", model: "hermes" })).toEqual({
      workerId: undefined,
      model: undefined,
    });
  });

  it("the router's same-model rule uses the gate's key: another account of the writer's model is avoided", async () => {
    const cc = candidate("sonnet");
    const claude = {
      ...candidate("sonnet"),
      id: "99999999-9999-4999-8999-999999999999",
      metadata: {
        ...candidate("sonnet").metadata,
        model: "claude/claude-sonnet-5",
        provider: "claude",
      },
    };
    const review = await router([cc, claude, candidate("opus")]).route(
      { requiredCapabilities: ["review"], excludeWorkerIds: [cc.id] },
      {
        role: "reviewer",
        complexity: "medium",
        repositoryMutation: false,
        correctionAttempt: 0,
        priorAttempts: [],
        writerWorkerId: cc.id,
      },
    );
    expect(review.worker?.id).toBe(id("opus"));
    expect(
      review.evidence!.candidateSet.find((c) => c.workerId === claude.id)!.excludedBecause,
    ).toContain("SAME_MODEL_AS_WRITER");
  });

  it("the same model under another route's NAME is the same judge (router side)", () => {
    expect(
      sameEffectiveModel("oc/nemotron-3-ultra-free", "nvidia/nvidia/nemotron-3-ultra-550b-a55b"),
    ).toBe(true);
    expect(
      sameEffectiveModel("oc/oc/nemotron-3-super-free", "nvidia/nvidia/nemotron-3-super-120b-a12b"),
    ).toBe(true);
    expect(sameEffectiveModel("cc/claude-sonnet-5-20260915", "claude/claude-sonnet-5")).toBe(true);
    expect(sameEffectiveModel("cc/claude-opus-5", "nvidia/nvidia/nemotron-3-ultra-550b-a55b")).toBe(
      false,
    );
    /* Not every -max/-ultra is an effort variant: these are distinct models. */
    expect(sameEffectiveModel("x/qwen3-max", "x/qwen3")).toBe(false);
  });

  it("FABLE is escalation compute: never chosen for routine work, chosen after repeated lower-tier failure", async () => {
    const fable = (() => {
      const [m] = classifyModels(["anthropic/claude-fable-5-1"]);
      expect(m!.family).toBe("CLAUDE_FABLE");
      return candidate("opus", {
        id: "fab1e000-0000-4000-8000-000000000000",
        metadata: { model: m!.modelId, provider: "anthropic", modelFamily: "CLAUDE_FABLE" },
      });
    })();
    const pool = [...fleet(["haiku", "n120", "sonnet", "sol", "n550", "opus"]), fable];

    for (const complexity of ["low", "medium", "high"] as const) {
      const routine = await router(pool).route(
        { requiredCapabilities: ["code_editing"] },
        writer({ complexity }),
      );
      expect(routine.worker?.id).not.toBe(fable.id);
    }

    const history = [
      ...outcomes("opus", 6, { failureClass: "EXECUTION_TIMEOUT" }),
      ...outcomes("n550", 6, { failureClass: "EXECUTION_TIMEOUT" }),
    ];
    const escalated = await router(pool, { history }).route(
      { requiredCapabilities: ["code_editing"] },
      writer({
        complexity: "high",
        correctionAttempt: 3,
        priorAttempts: [
          { attempt: 1, workerId: id("sonnet"), reviewVerdict: "REQUEST_CHANGES" },
          { attempt: 2, workerId: id("sol"), reviewVerdict: "REQUEST_CHANGES" },
          { attempt: 3, workerId: id("opus"), reviewVerdict: "REQUEST_CHANGES" },
          { attempt: 4, workerId: id("n550"), failureClass: "EXECUTION_TIMEOUT" },
        ],
      }),
    );
    expect(escalated.evidence!.requiredTier).toBe(6);
    expect(escalated.worker?.id).toBe(fable.id);
  });

  it("without Fable, the worst escalation is capped at the fleet's top tier: no forced Opus, no spurious fallback", async () => {
    const result = await router(fleet()).route(
      { requiredCapabilities: ["code_editing"] },
      writer({
        complexity: "high",
        correctionAttempt: 3,
        priorAttempts: [{ attempt: 4, workerId: id("sonnet"), failureClass: "EXECUTION_TIMEOUT" }],
      }),
    );
    expect(result.evidence!.requiredTier).toBe(5);
    expect(result.evidence!.escalationReason.join(" ")).toMatch(/capped at 5/);
    expect(result.evidence!.candidateSet.some((c) => c.fallback)).toBe(false);
    for (const k of ["sol", "n550", "opus"] as const) {
      expect(result.evidence!.candidateSet.find((c) => c.workerId === id(k))!.selectable).toBe(
        true,
      );
    }
  });

  it("TIER_FALLBACK: the only fitting model is cooling down -> the strongest remaining one is used, and marked", async () => {
    const limited = outcomes("opus", 1, { failureClass: "RATE_LIMITED", at: ago(60_000) });
    const result = await router(fleet(["n120", "opus"]), { history: limited }).route(
      { requiredCapabilities: ["code_editing"] },
      writer({ complexity: "high", correctionAttempt: 2 }),
    );
    expect(result.worker?.id).toBe(id("n120"));
    expect(result.evidence!.candidateSet.find((c) => c.workerId === id("n120"))!.fallback).toBe(
      "TIER_FALLBACK",
    );
  });
});
