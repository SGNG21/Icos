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
}

export interface MissionPlan {
  version: number;
  tasks: MissionPlanTask[];
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
