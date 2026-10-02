import { stripUntrustedMetadata } from "@/core/supervisor/priority";
import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import { zodDetails } from "@/server/http/errors";

import { HighLevelGoalInputSchema, HighLevelGoalSchema } from "@/core/contracts/high-level-goal";

/**
 * Phase 8 — High-level goal intake endpoint.
 *
 * This endpoint accepts a high-level goal input (title and objective) and returns
 * a normalized goal and a plan preview (mission title, objective, and tasks).
 *
 * It does not create a mission yet; that is done via a separate endpoint.
 *
 * Requires an authenticated ICOS session with the `missions.write` permission
 * (operator and above); the proxy is never the security barrier.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createGoalBodySchema = HighLevelGoalInputSchema;

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed): nothing is read, parsed, created or revealed
    // (not even configuration state) before the ICOS session + permission are checked.
    // We use the same permission as POST /api/missions: it creates missions.
    const access = await protectRoute({
      container,
      request,
      route: "api.goals.create",
      permission: "missions.write",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = createGoalBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    /*
     * Trust boundary (decision 0065): metadata arriving over HTTP may not carry the
     * reserved `icos.` namespace. Those keys decide the goal's priority CLASS, and a
     * caller that could set them would be choosing its own place in the queue.
     */
    const goal = container.goalNormalizer.normalize({
      ...parsed.data,
      ...(parsed.data.metadata
        ? { metadata: stripUntrustedMetadata(parsed.data.metadata) }
        : {}),
    });

    // Validate the normalized goal (throws if invalid).
    HighLevelGoalSchema.parse(goal);

    // Plan the goal using the container's planner.
    const preview = container.goalPlanner.plan(goal);

    // Store the normalized goal and its preview for later preview validation.
    await container.goalPreviewStore.store(goal.id, goal, preview);

    // Return the preview.
    return json({ goal, preview });
  } catch (error) {
    // TODO: better error handling
    return apiError("internal_error", "erreur interne");
  }
}