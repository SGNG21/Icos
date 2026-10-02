import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { buildObjectiveReadModel } from "@/server/supervisor/objective-read-model";

/**
 * Objective read model — READ-ONLY (decision 0065).
 *
 * Answers "what is ICOS doing?" at objective level. Derived on every request from
 * canonical rows: it writes nothing, holds no rule, and has no write verb. Fields whose
 * source truth is absent come back as UNKNOWN rather than as a plausible value.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed): nothing is read before the session is checked.
    const access = await protectRoute({
      container,
      request,
      route: "api.supervisor.objectives",
      permission: "cockpit.read",
    });
    if (!access.ok) return access.response;

    const objectives = await buildObjectiveReadModel({
      goals: container.goalRepository,
      missions: container.mission,
      reviews: container.reviewDecisions,
      runtimes: { get: (missionId) => container.autonomousRuntime.get(missionId) },
      controlHolds: {
        /*
         * The canonical control authority answers this, not a status heuristic. Read-only:
         * asking the guard whether NEW work is admissible for a mission is how a hold
         * becomes visible, and is the only contact this projection has with control.
         */
        async isHeld(missionId) {
          const decision = await container.controlGuard.dispatch(missionId);
          return !decision.allowed;
        },
      },
    });

    return json({ objectives });
  } catch (error) {
    return toErrorResponse(error);
  }
}
