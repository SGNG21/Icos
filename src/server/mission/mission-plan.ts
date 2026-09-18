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
