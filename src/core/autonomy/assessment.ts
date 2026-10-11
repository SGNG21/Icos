/**
 * AUTONOMY ASSESSMENT (BR-06) — pure.
 *
 * Places ICOS on the L0–L6 ladder from DURABLE EVIDENCE ONLY: rows that CORE3, the dispatch
 * ledger, the reviewers, the integration gate and the audit journal already write. Nothing
 * here estimates, extrapolates or defaults: a source that could not be read makes its
 * dimension UNKNOWN, a readable source with no proof makes it UNPROVEN, and the level is
 * UNKNOWN whenever a rung it depends on is UNKNOWN. In-memory counters (the
 * `SelfDevelopmentMetrics` service) are deliberately NOT evidence: they reset at every boot.
 *
 * Certification names WHERE the evidence was produced, from the runtime's own declaration
 * (`ICOS_RUNTIME_TIER`): a proof measured in a runtime that declares no tier is credited as
 * CODE_READY only — the code demonstrably runs, but nobody certified the environment.
 */

export const AUTONOMY_LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5", "L6"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_DIMENSIONS = [
  "planning",
  "routing",
  "recovery",
  "review",
  "integration",
  "self_development",
  "deployment",
] as const;
export type AutonomyDimensionKey = (typeof AUTONOMY_DIMENSIONS)[number];

export const DIMENSION_LABEL: Record<AutonomyDimensionKey, string> = {
  planning: "Planning",
  routing: "Routing",
  recovery: "Recovery",
  review: "Review",
  integration: "Integration",
  self_development: "Self-development",
  deployment: "Deployment",
};

/** UNKNOWN = the source could not be read. UNPROVEN = read, and no proof exists yet. */
export type DimensionState = "PROVEN" | "UNPROVEN" | "UNKNOWN";

/**
 * NONE: no code path produces this evidence. CODE_READY: the code exists (and may have run
 * somewhere undeclared). LAB/LIVE_CERTIFIED: proof rows exist in a runtime that declares
 * that tier.
 */
export type Certification = "NONE" | "CODE_READY" | "LAB_CERTIFIED" | "LIVE_CERTIFIED";

export type RuntimeTier = "lab" | "live";

/** One read of one durable source. `unavailable` carries no internals, only the fact. */
export type SourceRead<T> =
  | { readonly kind: "read"; readonly value: T }
  | { readonly kind: "unavailable"; readonly reason: string };

export const read = <T>(value: T): SourceRead<T> => ({ kind: "read", value });
export const unavailable = <T = never>(reason: string): SourceRead<T> => ({
  kind: "unavailable",
  reason,
});

/** A proof: what happened, where it is recorded, when. Rendered verbatim, never summarised away. */
export interface EvidenceRef {
  readonly source: string;
  readonly ref: string;
  readonly at: string | null;
  readonly summary: string;
}

/**
 * The facts the server reads (see `autonomy-evidence.ts`). Each list holds only PROOF
 * items — the reader applies the canonical predicates; this module only counts and ranks.
 */
export interface AutonomyEvidence {
  readonly tier: RuntimeTier | undefined;
  /** Missions ICOS created from a goal with system-authored tasks (planner ran, no human). */
  readonly planned: SourceRead<readonly EvidenceRef[]>;
  /** Dispatch attempts a routed worker completed, with a successful execution result. */
  readonly routed: SourceRead<readonly EvidenceRef[]>;
  /** A failed execution followed by a later attempt that completed on the same mission task. */
  readonly recovered: SourceRead<readonly EvidenceRef[]>;
  /** Review decisions issued by a non-human reviewer (deterministic or LLM) on a settled mission. */
  readonly reviewed: SourceRead<readonly EvidenceRef[]>;
  /** Integration gate reports that ACCEPTED, recorded durably. */
  readonly integrated: SourceRead<readonly EvidenceRef[]>;
  /** Goals whose provenance is self-development, with the mission that completed. */
  readonly selfDeveloped: SourceRead<readonly EvidenceRef[]>;
  /** Goals of self-development provenance (detect → propose), whatever their outcome. */
  readonly selfProposed: SourceRead<readonly EvidenceRef[]>;
}

export interface DimensionAssessment {
  readonly key: AutonomyDimensionKey;
  readonly label: string;
  readonly state: DimensionState;
  readonly certification: Certification;
  readonly proofs: number;
  readonly evidence: readonly EvidenceRef[];
  readonly lastEvidenceAt: string | null;
  readonly limits: readonly string[];
}

export interface AutonomyAssessment {
  readonly level: AutonomyLevel | "UNKNOWN";
  readonly levelReason: string;
  /** Rungs the current evidence vocabulary can never prove; shown as UNKNOWN on the ladder. */
  readonly unmeasurableLevels: readonly AutonomyLevel[];
  readonly certification: Certification;
  readonly tier: RuntimeTier | undefined;
  readonly dimensions: readonly DimensionAssessment[];
  readonly limits: readonly string[];
  readonly assessedAt: string;
}

/** How many proofs are shown per dimension; the count stays exact. */
const EVIDENCE_SHOWN = 5;

const TIER_LIMIT =
  "ICOS_RUNTIME_TIER is not declared: proofs measured here are credited as CODE_READY, not certified.";

function certify(tier: RuntimeTier | undefined, proven: boolean): Certification {
  if (!proven) return "CODE_READY";
  if (tier === "live") return "LIVE_CERTIFIED";
  if (tier === "lab") return "LAB_CERTIFIED";
  return "CODE_READY";
}

function latest(evidence: readonly EvidenceRef[]): string | null {
  let out: string | null = null;
  for (const e of evidence) if (e.at && (out === null || e.at > out)) out = e.at;
  return out;
}

function dimension(
  key: AutonomyDimensionKey,
  source: SourceRead<readonly EvidenceRef[]>,
  tier: RuntimeTier | undefined,
  extraLimits: readonly string[] = [],
): DimensionAssessment {
  if (source.kind === "unavailable") {
    return {
      key,
      label: DIMENSION_LABEL[key],
      state: "UNKNOWN",
      certification: "CODE_READY",
      proofs: 0,
      evidence: [],
      lastEvidenceAt: null,
      limits: [source.reason, ...extraLimits],
    };
  }
  const proven = source.value.length > 0;
  const limits = [...extraLimits];
  if (proven && tier === undefined) limits.push(TIER_LIMIT);
  if (!proven) limits.push("No durable proof row exists yet in this runtime.");
  return {
    key,
    label: DIMENSION_LABEL[key],
    state: proven ? "PROVEN" : "UNPROVEN",
    certification: certify(tier, proven),
    proofs: source.value.length,
    evidence: source.value.slice(0, EVIDENCE_SHOWN),
    lastEvidenceAt: latest(source.value),
    limits,
  };
}

/**
 * The ladder, as the cockpit defines it (src/app/cockpit/autonomy/page.tsx):
 *   L1 Assisted      — planning proven (ICOS proposes/plans), nothing executed by ICOS.
 *   L2 Orchestrated  — planning + routing proven (ICOS dispatched and a worker delivered).
 *   L3 Recovering    — L2 + recovery proven (a failed attempt was retried and completed).
 *   L4 Self-developing — L3 + review + integration + self-development proven.
 *   L5 / L6          — need value-based prioritisation evidence that no ICOS source records.
 */
const RUNGS: ReadonlyArray<readonly [AutonomyLevel, readonly AutonomyDimensionKey[]]> = [
  ["L1", ["planning"]],
  ["L2", ["routing"]],
  ["L3", ["recovery"]],
  ["L4", ["review", "integration", "self_development"]],
];

export const UNMEASURABLE_LEVELS: readonly AutonomyLevel[] = ["L5", "L6"];

export function assessAutonomy(evidence: AutonomyEvidence, now: Date): AutonomyAssessment {
  const tier = evidence.tier;
  const dims: Record<AutonomyDimensionKey, DimensionAssessment> = {
    planning: dimension("planning", evidence.planned, tier),
    routing: dimension("routing", evidence.routed, tier),
    recovery: dimension("recovery", evidence.recovered, tier),
    review: dimension("review", evidence.reviewed, tier),
    integration: dimension("integration", evidence.integrated, tier),
    self_development: dimension("self_development", evidence.selfDeveloped, tier, [
      evidence.selfProposed.kind === "read"
        ? `${evidence.selfProposed.value.length} self-development goal(s) proposed; a dimension proof needs one that completed.`
        : evidence.selfProposed.reason,
    ]),
    deployment: {
      key: "deployment",
      label: DIMENSION_LABEL.deployment,
      state: "UNKNOWN",
      certification: "NONE",
      proofs: 0,
      evidence: [],
      lastEvidenceAt: null,
      limits: [
        "No ICOS source records a deployment (release ledger): deployment stays a human act.",
      ],
    },
  };

  let level: AutonomyLevel | "UNKNOWN" = "L0";
  let levelReason = "No dimension is proven: every step is still performed by a human.";
  for (const [rung, keys] of RUNGS) {
    const states = keys.map((k) => dims[k].state);
    if (states.includes("UNKNOWN")) {
      const unknown = keys.filter((k) => dims[k].state === "UNKNOWN").map((k) => dims[k].label);
      level = "UNKNOWN";
      levelReason = `${rung} cannot be decided: ${unknown.join(", ")} evidence could not be read.`;
      break;
    }
    if (states.every((s) => s === "PROVEN")) {
      level = rung;
      levelReason = `${rung}: ${keys.map((k) => `${dims[k].label} proven (${dims[k].proofs})`).join(", ")}.`;
      continue;
    }
    const missing = keys.filter((k) => dims[k].state !== "PROVEN").map((k) => dims[k].label);
    levelReason = `${level}: ${rung} needs ${missing.join(", ")} proven.`;
    break;
  }

  const provenDims = AUTONOMY_DIMENSIONS.filter((k) => dims[k].state === "PROVEN");
  const certification: Certification =
    level === "UNKNOWN" || level === "L0"
      ? "CODE_READY"
      : provenDims.every((k) => dims[k].certification === "LIVE_CERTIFIED")
        ? "LIVE_CERTIFIED"
        : provenDims.every(
              (k) =>
                dims[k].certification === "LAB_CERTIFIED" ||
                dims[k].certification === "LIVE_CERTIFIED",
            )
          ? "LAB_CERTIFIED"
          : "CODE_READY";

  const limits: string[] = [
    "L5 and L6 are not measurable: no ICOS source records value-based prioritisation.",
    "In-memory self-development counters are not evidence (they reset at boot); only durable rows count.",
  ];
  if (tier === undefined && provenDims.length > 0) limits.push(TIER_LIMIT);

  return {
    level,
    levelReason,
    unmeasurableLevels: UNMEASURABLE_LEVELS,
    certification,
    tier,
    dimensions: AUTONOMY_DIMENSIONS.map((k) => dims[k]),
    limits,
    assessedAt: now.toISOString(),
  };
}
