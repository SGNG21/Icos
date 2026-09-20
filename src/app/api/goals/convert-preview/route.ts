import { z } from "zod";

import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import { zodDetails } from "@/server/http/errors";

import { GoalPlanPreviewSchema, GoalPlanPreview } from "@/core/contracts/high-level-goal";
import { MissionService } from "@/server/mission/mission-service";

/**
 * Phase 8 — Convert a goal plan preview to a mission.
 *
 * This endpoint accepts a goal plan preview (created by the goal intake endpoint) and
 * creates a mission in the system.
 *
 * It does not start the mission; that is done by the existing autonomous mission ignition
 * endpoint or by manual scheduling.
 *
 * Requires an authenticated ICOS session with the `missions.write` permission
 * (operator and above); the proxy is never the security barrier.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const convertPreviewBodySchema = z.object({
  preview: GoalPlanPreviewSchema,
}).strict();

/**
 * Validates that all task dependencies exist and that there are no cycles.
 * @param tasks - Array of tasks from the preview.
 * @throws {Error} if validation fails.
 */
function validateTaskDependencies(tasks: GoalPlanPreview["tasks"]): void {
  const taskMap = new Map<string, GoalPlanPreview["tasks"][number]>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // 1. Check for unknown dependencies
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (!taskMap.has(depId)) {
        throw new Error(`Unknown dependency: ${depId} for task ${task.id}`);
      }
    }
  }

  // 2. Check for cycles using DFS (depth-first search)
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(taskId: string): boolean {
    if (recStack.has(taskId)) {
      return true; // cycle
    }
    if (visited.has(taskId)) {
      return false;
    }

    visited.add(taskId);
    recStack.add(taskId);

    const task = taskMap.get(taskId);
    if (task) {
      for (const depId of task.dependsOn) {
        if (dfs(depId)) {
          return true;
        }
      }
    }

    recStack.delete(taskId);
    return false;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (dfs(task.id)) {
        throw new Error(`Cycle detected involving task ${task.id}`);
      }
    }
  }
}

/**
 * Compares two GoalPlanPreview objects for deep equality, treating undefined and null as equal
 * for optional fields.
 */
function previewsEqual(a: GoalPlanPreview, b: GoalPlanPreview): boolean {
  // Compare goalId, missionTitle, missionObjective
  if (a.goalId !== b.goalId) return false;
  if (a.missionObjective !== b.missionObjective) return false;
  if (a.missionTitle !== b.missionTitle) return false;

  // Compare tasks array length
  if (a.tasks.length !== b.tasks.length) return false;

  // Compare each task
  for (let i = 0; i < a.tasks.length; i++) {
    const taskA = a.tasks[i];
    const taskB = b.tasks[i];

    if (taskA.id !== taskB.id) return false;
    if (taskA.title !== taskB.title) return false;
    if ((taskA.description ?? null) !== (taskB.description ?? null)) return false;
    // dependsOn: arrays of strings, order matters? We assume order is significant as per planner.
    if (JSON.stringify(taskA.dependsOn) !== JSON.stringify(taskB.dependsOn)) return false;
    if ((taskA.capability ?? null) !== (taskB.capability ?? null)) return false;
    if ((taskA.workerKind ?? null) !== (taskB.workerKind ?? null)) return false;
    if (taskA.riskLevel !== taskB.riskLevel) return false;
    if (taskA.humanApprovalRequired !== taskB.humanApprovalRequired) return false;
    if (JSON.stringify(taskA.acceptanceCriteria) !== JSON.stringify(taskB.acceptanceCriteria))
      return false;
    if (taskA.parallelizable !== taskB.parallelizable) return false;
    if (taskA.sandboxRequired !== taskB.sandboxRequired) return false;
    if (taskA.isolatedWorkspaceRequired !== taskB.isolatedWorkspaceRequired) return false;
  }

  return true;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed): nothing is read, parsed, created or revealed
    // (not even configuration state) before the ICOS session + permission are checked.
    // We use the same permission as POST /api/missions: it creates missions.
    const access = await protectRoute({
      container,
      request,
      route: "api.goals.convert-preview",
      permission: "missions.write",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = convertPreviewBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    const { preview } = parsed.data;

    // Validate the preview (throws if invalid).
    GoalPlanPreviewSchema.parse(preview);
    // Additional security checks (defense in depth, though preview equality should catch most)
    // We'll still check for self-dependency and at least one task.
    for (const task of preview.tasks) {
      // Self-dependency
      if (task.dependsOn.includes(task.id)) {
        return apiError("invalid_input", "auto-dépendance détectée");
      }
    }

    if (preview.tasks.length === 0) {
      return apiError("invalid_input", "aucune tâche définie");
    }

    // Validate task dependencies and acyclicity.
    validateTaskDependencies(preview.tasks);

    // Retrieve the normalized goal from the preview store.
    const goal = await container.goalPreviewStore.retrieve(preview.goalId);
    if (!goal) {
      // Goal not found (maybe expired or never stored)
      return apiError("invalid_input", "goal introuvable ou expiré");
    }

    // Regenerate the canonical preview from the goal.
    const canonicalPreview = await container.goalPlanner.plan(goal);

    // Compare the received preview with the canonical preview.
    if (!previewsEqual(preview, canonicalPreview)) {
      // Preview has been tampered with.
      return apiError("invalid_input", "preview non autorisé");
    }

    // Convert the preview tasks to the format expected by MissionService.createMission.
    const missionTasksInput = preview.tasks.map((task) => ({
      title: task.title,
      description: task.description ?? null,
      dependsOn: task.dependsOn,
      workerKind: task.workerKind ?? null,
      capability: task.capability ?? null,
    }));

    // Create the mission.
    const missionService = new MissionService(container.mission);
    const mission = await missionService.createMission({
      title: preview.missionTitle,
      objective: preview.missionObjective,
      tasks: missionTasksInput,
    });

    // Return the created mission.
    return json({ mission });
  } catch (error) {
    // TODO: better error handling
    if (error instanceof Error) {
      // For dependency or cycle errors, we return 400.
      if (error.message.startsWith("Unknown dependency") || error.message.startsWith("Cycle detected")) {
        return apiError("invalid_input", error.message);
      }
    }
    return apiError("internal_error", "erreur interne");
  }
}