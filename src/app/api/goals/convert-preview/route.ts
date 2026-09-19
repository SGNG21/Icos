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
    return apiError("internal_error", "erreur interne");
  }
}