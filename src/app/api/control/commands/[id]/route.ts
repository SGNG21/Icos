import { z } from "zod";

import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";

/**
 * GET /api/control/commands/:commandId — the stored result of a command.
 * An ADMITTED command is reconciled against canonical state (never re-executed);
 * if its outcome is still unobservable the answer is UNKNOWN_EXECUTION_STATE.
 * Only the actor (or an owner/admin) can read a command.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.control.commands.read",
      permission: "cockpit.read",
    });
    if (!access.ok) return access.response;
    if (!container.control) return apiError("persistence_unavailable", "control plane unavailable");

    const id = z
      .string()
      .uuid()
      .safeParse((await context.params).id);
    if (!id.success) return apiError("invalid_input", "commandId must be a UUID");

    const result = await container.control.bus.get(access.session, id.data);
    if (!result) return apiError("not_found", "command not found");
    return json(result, { status: result.status === "UNKNOWN_EXECUTION_STATE" ? 202 : 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
