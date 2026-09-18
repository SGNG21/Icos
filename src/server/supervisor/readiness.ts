import type { Mission, MissionTask } from "@/core/mission/contracts";

export function computeReadyTasks(mission: Mission, tasks: MissionTask[]): MissionTask[] {
  // Mission check
  const terminalMissionStates = ["succeeded", "failed", "cancelled"];
  if (terminalMissionStates.includes(mission.status)) {
    return [];
  }

  // Find all task IDs that have succeeded
  const succeededTaskIds = new Set(tasks.filter((t) => t.status === "succeeded").map((t) => t.id));

  return tasks.filter((task) => {
    // Task must not be terminal, queued, running, under review, or superseded.
    const nonReadyStates = [
      "succeeded",
      "failed",
      "cancelled",
      "queued",
      "running",
      "awaiting_approval",
      "blocked",
      "review_pending",
      "superseded",
    ];
    if (nonReadyStates.includes(task.status)) {
      return false;
    }

    // Dependencies must be satisfied
    for (const dep of task.dependsOn) {
      if (!succeededTaskIds.has(dep)) {
        return false;
      }
    }

    return true;
  });
}
