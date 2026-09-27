import { createHash } from "node:crypto";

export interface MissionPlanTask {
  /**
   * Stable planner-local identifier.
   *
   * This is NOT a MissionTask.id and NOT a canonical Task.id.
   * Dependencies in MissionPlan always reference these keys.
   */
  key: string;

  title: string;
  description?: string;

  dependsOn: string[];

  workerKind?: string;
  capability?: string;

  /*
   * Canonical planning metadata (mission N11).
   *
   * Optional on the wire so an older planner keeps working, but VALIDATED when
   * present and carried all the way to the canonical Task instead of being
   * hardcoded at the repository boundary. Absent values fall back to the
   * documented defaults in PLAN_TASK_DEFAULTS below — one place, not a literal
   * repeated at every call site.
   */
  objective?: string;
  instructions?: string;
  successCriteria?: string[];
  requiredCapabilities?: string[];
  riskClass?: RiskClass;
  allowedFileScope?: string[];
  expectedArtifacts?: string[];
  priority?: number;
  attemptBudget?: number;
  reviewPolicy?: ReviewPolicy;
  integrationPolicy?: string;
}

export type RiskClass =
  | "read_only"
  | "reversible"
  | "sensitive";

export type ReviewPolicy =
  | "never"
  | "if_risky"
  | "always";

export const RISK_CLASSES: readonly RiskClass[] = [
  "read_only",
  "reversible",
  "sensitive",
];

export const REVIEW_POLICIES: readonly ReviewPolicy[] =
  ["never", "if_risky", "always"];

/*
 * Defaults applied when the planner omits a field.
 *
 * These preserve the behavior that applyPlan previously hardcoded, so enabling
 * planner-supplied metadata changes nothing for an existing planner. An INVALID
 * value is never defaulted — validateMissionPlan rejects it, because silently
 * downgrading an unrecognized risk class would be exactly the "dangerous
 * unknown risk" mission N12 requires to fail closed.
 */
export const PLAN_TASK_DEFAULTS = {
  riskClass: "reversible" as RiskClass,
  priority: 3,
  attemptBudget: 3,
  reviewPolicy: "if_risky" as ReviewPolicy,
  integrationPolicy: "",
} as const;

export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 5;
export const MIN_ATTEMPT_BUDGET = 1;

export interface MissionPlan {
  version: number;
  tasks: MissionPlanTask[];
}

/*
 * Canonical planning metadata validation (mission N12).
 *
 * Fails closed: an unrecognized risk class or review policy is REJECTED, never
 * coerced to a default. A malformed success criterion, capability, file-scope
 * entry or expected artifact is rejected rather than silently dropped, because
 * a task whose safety envelope cannot be trusted must not reach a worker.
 *
 * Called from inside validateMissionPlan's existing per-task loop — this is not
 * a second validator, and there is no separate entry point to forget to call.
 */
function validatePlanTaskMetadata(
  key: string,
  task: MissionPlanTask,
): void {
  const requireNonEmptyStrings = (
    values: string[] | undefined,
    field: string,
  ): void => {
    if (values === undefined) {
      return;
    }

    for (const value of values) {
      if (
        typeof value !== "string" ||
        !value.trim()
      ) {
        throw new Error(
          `MISSION_PLAN_INVALID_${field}:${key}`,
        );
      }
    }

    if (
      new Set(values.map((v) => v.trim())).size !==
      values.length
    ) {
      throw new Error(
        `MISSION_PLAN_DUPLICATE_${field}:${key}`,
      );
    }
  };

  if (
    task.riskClass !== undefined &&
    !RISK_CLASSES.includes(task.riskClass)
  ) {
    throw new Error(
      `MISSION_PLAN_INVALID_RISK_CLASS:${key}:` +
        `${String(task.riskClass)}`,
    );
  }

  if (
    task.reviewPolicy !== undefined &&
    !REVIEW_POLICIES.includes(task.reviewPolicy)
  ) {
    throw new Error(
      `MISSION_PLAN_INVALID_REVIEW_POLICY:${key}:` +
        `${String(task.reviewPolicy)}`,
    );
  }

  if (task.priority !== undefined) {
    if (
      !Number.isInteger(task.priority) ||
      task.priority < MIN_PRIORITY ||
      task.priority > MAX_PRIORITY
    ) {
      throw new Error(
        `MISSION_PLAN_INVALID_PRIORITY:${key}:` +
          `${String(task.priority)}`,
      );
    }
  }

  if (task.attemptBudget !== undefined) {
    if (
      !Number.isInteger(task.attemptBudget) ||
      task.attemptBudget < MIN_ATTEMPT_BUDGET
    ) {
      throw new Error(
        `MISSION_PLAN_INVALID_ATTEMPT_BUDGET:` +
          `${key}:${String(task.attemptBudget)}`,
      );
    }
  }

  if (
    task.objective !== undefined &&
    !task.objective.trim()
  ) {
    throw new Error(
      `MISSION_PLAN_EMPTY_OBJECTIVE:${key}`,
    );
  }

  requireNonEmptyStrings(
    task.successCriteria,
    "SUCCESS_CRITERION",
  );
  requireNonEmptyStrings(
    task.requiredCapabilities,
    "REQUIRED_CAPABILITY",
  );
  requireNonEmptyStrings(
    task.allowedFileScope,
    "ALLOWED_FILE_SCOPE",
  );
  requireNonEmptyStrings(
    task.expectedArtifacts,
    "EXPECTED_ARTIFACT",
  );

  /*
   * A sensitive task must declare how it will be reviewed. Leaving review to
   * the default when the planner has explicitly marked the work sensitive is
   * the unsafe-by-omission case mission N12 calls out.
   */
  if (
    task.riskClass === "sensitive" &&
    task.reviewPolicy === "never"
  ) {
    throw new Error(
      `MISSION_PLAN_SENSITIVE_TASK_UNREVIEWED:${key}`,
    );
  }
}

export function validateMissionPlan(
  plan: MissionPlan,
): void {
  if (
    !Number.isInteger(plan.version) ||
    plan.version < 1
  ) {
    throw new Error(
      "MISSION_PLAN_INVALID_VERSION",
    );
  }

  if (plan.tasks.length === 0) {
    throw new Error(
      "MISSION_PLAN_EMPTY",
    );
  }

  const byKey = new Map<
    string,
    MissionPlanTask
  >();

  for (const task of plan.tasks) {
    const key = task.key.trim();

    if (!key) {
      throw new Error(
        "MISSION_PLAN_EMPTY_KEY",
      );
    }

    if (!task.title.trim()) {
      throw new Error(
        `MISSION_PLAN_EMPTY_TITLE:${key}`,
      );
    }

    if (byKey.has(key)) {
      throw new Error(
        `MISSION_PLAN_DUPLICATE_KEY:${key}`,
      );
    }

    validatePlanTaskMetadata(key, task);

    byKey.set(key, task);
  }

  for (const [key, task] of byKey) {
    const seenDependencies =
      new Set<string>();

    for (const dependency of task.dependsOn) {
      if (dependency === key) {
        throw new Error(
          `MISSION_PLAN_SELF_DEPENDENCY:${key}`,
        );
      }

      if (!byKey.has(dependency)) {
        throw new Error(
          `MISSION_PLAN_UNKNOWN_DEPENDENCY:` +
            `${key}:${dependency}`,
        );
      }

      if (seenDependencies.has(dependency)) {
        throw new Error(
          `MISSION_PLAN_DUPLICATE_DEPENDENCY:` +
            `${key}:${dependency}`,
        );
      }

      seenDependencies.add(dependency);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (key: string): void => {
    if (visiting.has(key)) {
      throw new Error(
        `MISSION_PLAN_CYCLE:${key}`,
      );
    }

    if (visited.has(key)) {
      return;
    }

    visiting.add(key);

    const task = byKey.get(key);

    if (!task) {
      throw new Error(
        `MISSION_PLAN_INTERNAL_MISSING_TASK:${key}`,
      );
    }

    for (const dependency of task.dependsOn) {
      visit(dependency);
    }

    visiting.delete(key);
    visited.add(key);
  };

  for (const key of byKey.keys()) {
    visit(key);
  }
}

/*
 * Canonical JSON serialization for fingerprinting.
 *
 * Object keys are emitted in sorted order at every depth so that two
 * logically identical plans always serialize identically regardless of
 * property insertion order.
 *
 * Array order IS significant: a reordered task list is treated as a
 * different logical plan. This fails closed — it allocates a new plan
 * version rather than silently reusing a plan that may materialize
 * canonical tasks in a different order.
 *
 * Never use JSON.stringify(value, Object.keys(value).sort()): the second
 * argument is a replacer whitelist applied at EVERY depth, which strips
 * nested task properties and makes the fingerprint blind to plan content.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const entries = Object.entries(
    value as Record<string, unknown>,
  )
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(
      ([k, v]) =>
        `${JSON.stringify(k)}:${canonicalize(v)}`,
    )
    .join(",")}}`;
}

/**
 * Deterministic hash of the canonical logical content of a MissionPlan.
 *
 * This is the planFingerprint of mission §8. It is NOT a planId:
 * a planId identifies ONE persisted plan version, while the fingerprint
 * identifies logical plan CONTENT and is used only for idempotency
 * detection (an applyPlan retry of the same logical plan must reuse the
 * same persisted plan version instead of allocating a new one).
 */
export function fingerprintMissionPlan(
  plan: MissionPlan,
): string {
  return createHash("sha256")
    .update(canonicalize(plan))
    .digest("hex");
}

/**
 * Canonical planning metadata for ONE planned task, with defaults applied.
 *
 * Every field is concrete: callers materializing a canonical Task must not
 * re-invent fallbacks. This is the single place where an omitted planner field
 * becomes a value.
 */
export interface ResolvedPlanTaskMetadata {
  objective: string;
  instructions: string;
  successCriteria: string[];
  requiredCapabilities: string[];
  riskClass: RiskClass;
  allowedFileScope: string[];
  expectedArtifacts: string[];
  priority: number;
  attemptBudget: number;
  reviewPolicy: ReviewPolicy;
  integrationPolicy: string;
}

/**
 * Resolves planner-supplied task metadata, falling back to PLAN_TASK_DEFAULTS.
 *
 * Call AFTER validateMissionPlan: this function trusts its input and applies
 * defaults, it does not reject anything. Validation rejects malformed values so
 * that an invalid risk class can never reach a default here.
 *
 * Replaces the literals that applyPlan()/replacePlan() used to hardcode at four
 * separate call sites (riskClass 'reversible', priority 3, attemptBudget 3,
 * reviewPolicy 'if_risky', empty criteria/capabilities/scope/artifacts), which
 * meant planner output could never influence execution.
 */
export function resolvePlanTaskMetadata(
  task: MissionPlanTask,
): ResolvedPlanTaskMetadata {
  return {
    // The objective defaults to the title: a planned task always has a title.
    objective:
      task.objective?.trim() || task.title,
    instructions:
      task.instructions ?? task.description ?? "",
    successCriteria: [
      ...(task.successCriteria ?? []),
    ],
    requiredCapabilities: [
      ...(task.requiredCapabilities ??
        (task.capability ? [task.capability] : [])),
    ],
    riskClass:
      task.riskClass ??
      PLAN_TASK_DEFAULTS.riskClass,
    allowedFileScope: [
      ...(task.allowedFileScope ?? []),
    ],
    expectedArtifacts: [
      ...(task.expectedArtifacts ?? []),
    ],
    priority:
      task.priority ?? PLAN_TASK_DEFAULTS.priority,
    attemptBudget:
      task.attemptBudget ??
      PLAN_TASK_DEFAULTS.attemptBudget,
    reviewPolicy:
      task.reviewPolicy ??
      PLAN_TASK_DEFAULTS.reviewPolicy,
    integrationPolicy:
      task.integrationPolicy ??
      PLAN_TASK_DEFAULTS.integrationPolicy,
  };
}

export interface PlanExecutionOrder {
  /** Planner keys with no dependencies — the tasks that may start immediately. */
  roots: string[];
  /** Every planner key in a deterministic dependency-respecting order. */
  order: string[];
  /**
   * Execution levels. Level 0 is `roots`; every key in level N depends only on
   * keys in levels < N, so each level may run concurrently. This is what proves
   * safe parallelism rather than assuming it.
   */
  levels: string[][];
}

/**
 * Deterministic topological ordering of a MissionPlan (mission N12).
 *
 * Kahn's algorithm with lexicographic tie-breaking: whenever several tasks are
 * simultaneously available, the smallest key is emitted first. The result is
 * therefore a pure function of the plan's logical content and does NOT depend on
 * the order the planner happened to list its tasks in.
 *
 * Expects a plan that already passed validateMissionPlan. It does not
 * re-validate — there is one validator — but it does fail closed if the graph
 * turns out not to be a DAG, so a cycle can never be silently truncated into a
 * short execution order.
 */
export function planExecutionOrder(
  plan: MissionPlan,
): PlanExecutionOrder {
  const dependencies = new Map<
    string,
    Set<string>
  >();
  const dependents = new Map<string, string[]>();

  for (const task of plan.tasks) {
    dependencies.set(
      task.key,
      new Set(task.dependsOn),
    );
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      const list =
        dependents.get(dependency) ?? [];
      list.push(task.key);
      dependents.set(dependency, list);
    }
  }

  const remaining = new Map(
    [...dependencies].map(([key, deps]) => [
      key,
      new Set(deps),
    ]),
  );

  const roots = [...dependencies]
    .filter(([, deps]) => deps.size === 0)
    .map(([key]) => key)
    .sort();

  const order: string[] = [];
  const levels: string[][] = [];

  let available = [...roots];

  while (available.length > 0) {
    const level = [...available].sort();
    levels.push(level);
    order.push(...level);

    const next: string[] = [];

    for (const key of level) {
      remaining.delete(key);

      for (const dependent of dependents.get(
        key,
      ) ?? []) {
        const deps = remaining.get(dependent);

        if (!deps) {
          continue;
        }

        deps.delete(key);

        if (deps.size === 0) {
          next.push(dependent);
        }
      }
    }

    available = next;
  }

  if (order.length !== plan.tasks.length) {
    /*
     * Unreachable for a plan that passed validateMissionPlan. Fail closed
     * rather than return a partial order that would look like a shorter DAG.
     */
    throw new Error(
      "MISSION_PLAN_NOT_A_DAG",
    );
  }

  return { roots, order, levels };
}
