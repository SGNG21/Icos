import { z } from "zod";

import type { ControlState } from "@/core/control/contracts";
import { RUNTIME_TARGET_ID } from "@/core/control/contracts";
import { isMissionInScope, resolveOperationalScope } from "@/server/administration/mission-scope";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";

/**
 * GET /api/control/state?missionId=…&workerId=… — current control state and
 * the versions a client must send as `expectedVersion`. Read-only.
 * Missions outside the caller's operational scope are omitted.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ids = z.array(z.string().min(1).max(200)).max(200);

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.control.state",
      permission: "cockpit.read",
    });
    if (!access.ok) return access.response;
    if (!container.control) return apiError("persistence_unavailable", "control plane unavailable");

    const url = new URL(request.url);
    const missionIds = ids.safeParse(url.searchParams.getAll("missionId"));
    const workerIds = ids.safeParse(url.searchParams.getAll("workerId"));
    if (!missionIds.success || !workerIds.success)
      return apiError("invalid_input", "too many or invalid ids");

    const { store, guard } = container.control;
    const scope = await resolveOperationalScope(container, access.session);
    const visibleMissions: string[] = [];
    for (const id of missionIds.data) {
      if ((await container.mission.findById(id)) && (await isMissionInScope(container, id, scope)))
        visibleMissions.push(id);
    }

    const flags = await guard.flags();
    const [runtimeVersion, missionVersions, workerVersions, held] = await Promise.all([
      store.readVersions("runtime", [RUNTIME_TARGET_ID]).catch(() => null),
      store.readVersions("mission", visibleMissions),
      store.readVersions("worker", workerIds.data),
      Promise.all(visibleMissions.map((id) => store.isHeld(id).catch(() => true))),
    ]);

    const state: ControlState = {
      runtime: {
        stored: flags.stored,
        effective: flags.effective,
        version: runtimeVersion?.get(RUNTIME_TARGET_ID) ?? null,
      },
      missions: visibleMissions.map((id, i) => ({
        id,
        held: held[i],
        version: missionVersions.get(id) ?? 0,
      })),
      workers: workerIds.data.map((id) => ({ id, version: workerVersions.get(id) ?? 0 })),
    };
    return json(state);
  } catch (error) {
    return toErrorResponse(error);
  }
}
